import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { detailRecord, reportRecord, reportTotalsRecord } from '../test-support';
import { toEngagementDetail } from '../model';
import {
  EMPTY_CLOSE_FORM,
  EMPTY_REQUEST_FORM,
  canCloseEngagement,
  canRequestReport,
  closeBody,
  describeReport,
  holdsDay,
  reportable,
  requestBody,
  scopeUnits,
  shortHash,
  toReport,
  toTotals,
  validateClose,
  validateRequest,
} from './model';
import type { RequestForm } from './model';

const TODAY = '2027-01-04';
const UNIT = '00000000-0000-4000-8000-000000000003';
const CONCLUSION = '00000000-0000-4000-8000-000000000020';

describe('what the reads answer', () => {
  it('reads the figures frozen with a report, the two rates each with the numerator and the denominator', () => {
    expect(toTotals(reportTotalsRecord())).toEqual({
      asOfDate: '2027-01-04',
      total: 3,
      closed: 2,
      inProgress: 1,
      open: 0,
      disputed: 0,
      amountVnd: '1200000000',
      recoveredVnd: '1100000000',
      remainingVnd: '100000000',
      moneyRate: { numerator: '1100000000', denominator: '1200000000', percent: '91.67' },
      countRate: { numerator: '2', denominator: '3', percent: '66.67' },
    });
    for (const broken of [{ total: -1 }, { closed: 1.5 }, { amount: '12.5' }, { recovered: undefined }, { money_rate: { numerator: 'x' } }, { count_rate: null }, { as_of_date: 5 }]) {
      expect(toTotals(reportTotalsRecord(broken))).toBeUndefined();
    }
    expect(toTotals(null)).toBeUndefined();
  });

  it('reads a report with its hash, its status, who asked and who approved', () => {
    const issued = toReport(reportRecord(1, { status: 'ISSUED', report_document_id: CONCLUSION, issued_at: '2027-01-05T03:00:00Z', approved_by: { id: UNIT, display_name: 'Trần Thị Bình' } }));
    expect(issued).toMatchObject({
      conclusionSymbol: '88/BC-KTNN',
      asOfDate: '2027-01-04',
      revision: 1,
      status: 'ISSUED',
      documentId: CONCLUSION,
      rejectCode: null,
      requestedBy: { displayName: 'Nguyễn Văn An' },
      approvedBy: { id: UNIT, displayName: 'Trần Thị Bình' },
      issuedAt: '2027-01-05T03:00:00Z',
      version: 1,
    });
    expect(toReport(reportRecord(2, { approved_by: { id: UNIT } }))?.approvedBy).toEqual({ id: UNIT, displayName: '' });
    expect(toReport(reportRecord(3, { approved_by: { display_name: 'no id' } }))?.approvedBy).toBeNull();
    expect(toReport(reportRecord(4, { status: 'REJECTED', reject_code: 'PAYLOAD_SCHEMA_INVALID' }))?.rejectCode).toBe('PAYLOAD_SCHEMA_INVALID');
    for (const broken of [{ id: undefined }, { status: 'SENT' }, { revision: 'one' }, { payload_sha256: 'short' }, { totals: null }, { requested_by: null }, { requested_at: undefined }, { version: undefined }, { conclusion_id: 4 }, { as_of_date: undefined }]) {
      expect(toReport(reportRecord(5, broken))).toBeUndefined();
    }
    expect(toReport('x')).toBeUndefined();
  });

  it('shows the first characters of a hash and the units the engagement is about', () => {
    expect(shortHash('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe('0123456789ab');
    const detail = toEngagementDetail(detailRecord(1, { scope: [{ kind: 'UNIT', id: UNIT, code: 'SXD', name: 'Sở Xây dựng' }, { kind: 'PROJECT', id: CONCLUSION, code: 'DA', name: 'Cầu' }] }));
    expect(scopeUnits(detail?.scope ?? []).map((unit) => unit.code)).toEqual(['SXD']);
  });
});

describe('what the buttons are shown for', () => {
  it('shows the request to the holder of the permission to issue, and the closure to the holder of the permission to close, in a tenant that is not read only', () => {
    expect(canRequestReport(['aud.report.issue'], 'FULL')).toBe(true);
    expect(canRequestReport(undefined, undefined)).toBe(true);
    expect(canRequestReport(['aud.read'], 'FULL')).toBe(false);
    expect(canRequestReport(['aud.report.issue'], 'READ_ONLY')).toBe(false);
    expect(canCloseEngagement(['aud.engagement.close'], 'FULL')).toBe(true);
    expect(canCloseEngagement(['aud.report.issue'], 'FULL')).toBe(false);
    expect(canCloseEngagement(['aud.engagement.close'], 'READ_ONLY')).toBe(false);
  });

  it('asks for a report and closes only while the engagement is followed up, and a report holds its day while it waits for DOC or was issued', () => {
    expect(reportable({ status: 'FOLLOW_UP' })).toBe(true);
    for (const status of ['PLANNED', 'ONGOING', 'AWAITING_CONCLUSION', 'CLOSED', 'CANCELLED'] as const) expect(reportable({ status })).toBe(false);
    expect(['DRAFT', 'ISSUE_REQUESTED', 'ISSUED', 'REJECTED', 'RECALLED'].map((status) => holdsDay({ status: status as 'DRAFT' }))).toEqual([true, true, true, false, false]);
  });
});

describe('the request for a report', () => {
  const form = (overrides: Partial<RequestForm> = {}): RequestForm => ({ conclusionId: CONCLUSION, asOfDate: TODAY, place: 'Cao Bằng', draftingUnitId: UNIT, ...overrides });
  const bounds = { today: TODAY, receivedOn: '2026-10-15' };

  it('accepts a day from the day the conclusion was received to today, a place and a unit', () => {
    expect(validateRequest(form(), bounds)).toEqual({});
    expect(validateRequest(form({ asOfDate: '2026-10-15' }), bounds)).toEqual({});
    expect(validateRequest(form({ place: 'x'.repeat(100) }), bounds)).toEqual({});
  });

  it('says what is wrong with each field', () => {
    expect(validateRequest(EMPTY_REQUEST_FORM, bounds)).toEqual({ conclusionId: 'required', asOfDate: 'required', place: 'required', draftingUnitId: 'required' });
    expect(validateRequest(form({ asOfDate: 'yesterday' }), bounds).asOfDate).toBe('invalid');
    expect(validateRequest(form({ asOfDate: '2027-01-05' }), bounds).asOfDate).toBe('future');
    expect(validateRequest(form({ asOfDate: '2026-10-14' }), bounds).asOfDate).toBe('early');
    expect(validateRequest(form({ asOfDate: '2026-10-14' }), { today: TODAY, receivedOn: undefined }).asOfDate).toBeUndefined();
    expect(validateRequest(form({ place: 'x'.repeat(101) }), bounds).place).toBe('tooLong');
    expect(validateRequest(form({ place: 'Cao\u0007Bằng' }), bounds).place).toBe('invalid');
  });

  it('sends the day, the place and the unit as they are written, trimmed and in lower case', () => {
    expect(requestBody(form({ asOfDate: ` ${TODAY} `, place: '  Cao Bằng ', draftingUnitId: UNIT.toUpperCase() }))).toEqual({ conclusion_id: CONCLUSION, as_of_date: TODAY, place: 'Cao Bằng', drafting_unit_id: UNIT });
  });
});

describe('the closure', () => {
  const bounds = { today: TODAY, startedOn: '2026-10-01' };

  it('is on a day from the start of the engagement to today', () => {
    expect(validateClose({ onDate: TODAY }, bounds)).toEqual({});
    expect(validateClose({ onDate: '2026-10-01' }, bounds)).toEqual({});
    expect(validateClose(EMPTY_CLOSE_FORM, bounds)).toEqual({ onDate: 'required' });
    expect(validateClose({ onDate: 'soon' }, bounds)).toEqual({ onDate: 'invalid' });
    expect(validateClose({ onDate: '2027-01-05' }, bounds)).toEqual({ onDate: 'future' });
    expect(validateClose({ onDate: '2026-09-30' }, bounds)).toEqual({ onDate: 'early' });
    expect(validateClose({ onDate: '2020-01-01' }, { today: TODAY, startedOn: null })).toEqual({});
    expect(closeBody({ onDate: ` ${TODAY} ` })).toEqual({ on_date: TODAY });
  });
});

describe('what a refusal of the server is told as', () => {
  const refusal = (code: string, extensions: Record<string, unknown> = {}) => describeReport(new ApiError({ status: 409, code, correlationId: 'c', extensions }));

  it('names each refusal of the two commands', () => {
    expect(refusal('FOLLOW_UP_REPORT_EXISTS').problem).toBe('exists');
    expect(refusal('ENGAGEMENT_STATE_INVALID').problem).toBe('engagementState');
    expect(refusal('CONCLUSION_REVISION_INVALID').problem).toBe('conclusionReplaced');
    expect(refusal('DOC_TEMPLATE_MISSING').problem).toBe('templateMissing');
    expect(refusal('PROVIDER_UNAVAILABLE').problem).toBe('providerUnavailable');
    expect(refusal('FOLLOW_UP_REPORT_MISSING').problem).toBe('reportMissing');
    expect(refusal('VERSION_CONFLICT').problem).toBe('versionConflict');
    expect(refusal('SCOPE_DENIED').problem).toBe('scopeDenied');
    expect(['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED'].map((code) => refusal(code).problem)).toEqual(['validation', 'validation', 'validation']);
    expect(refusal('RESOURCE_NOT_FOUND').problem).toBe('notFound');
    expect(refusal('SOMETHING_NEW').problem).toBe('general');
    expect(describeReport(new Error('offline'))).toEqual({ problem: 'general', open: undefined });
  });

  it('says how many recommendations are still open when that is what stopped the closure', () => {
    expect(refusal('OPEN_RECOMMENDATIONS_REMAIN', { open_recommendations: 3 })).toEqual({ problem: 'openRecommendations', open: 3 });
    expect(refusal('OPEN_RECOMMENDATIONS_REMAIN', {})).toEqual({ problem: 'openRecommendations', open: undefined });
  });
});
