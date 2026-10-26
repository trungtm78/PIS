import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { linkRecord, overviewRecord, rateRecord, summaryRecord } from '../test-support';
import {
  EMPTY_LINK_FORM,
  EMPTY_REVERSE_FORM,
  canRecordRecovery,
  canReverse,
  describeRecovery,
  linkBody,
  percentText,
  recoverable,
  reverseBody,
  toOverview,
  toRecoveryLine,
  toRecoverySummary,
  validateLink,
  validateReverse,
} from './model';
import type { LinkForm } from './model';

const TODAY = '2026-10-26';
const DOCUMENT = '00000000-0000-4000-8000-000000000021';

describe('what the reads answer', () => {
  it('reads a line of the ledger with its sign, what was recovered up to it and what is left', () => {
    expect(toRecoveryLine(linkRecord(1))).toEqual({
      id: linkRecord(1).id,
      recommendationId: linkRecord(1).recommendation_id,
      code: 'KN-001',
      sourceKind: 'PAY_RECOVERY',
      amountVnd: '500000000',
      recordedOn: '2026-10-20',
      evidenceDocumentId: null,
      reversalOfId: null,
      reversed: false,
      note: null,
      cumulativeVnd: '500000000',
      remainingVnd: '300000000',
    });
    expect(toRecoveryLine(linkRecord(2, { amount_vnd: '-500000000', reversal_of_id: linkRecord(1).id, note: 'Nhập hai lần.', reversed: undefined, cumulative_vnd: '0', evidence_document_id: DOCUMENT }))).toMatchObject({
      amountVnd: '-500000000',
      reversalOfId: linkRecord(1).id,
      note: 'Nhập hai lần.',
      reversed: false,
      evidenceDocumentId: DOCUMENT,
    });
    for (const broken of [{ id: undefined }, { source_kind: 'GIFT' }, { amount_vnd: '12.5' }, { cumulative_vnd: undefined }, { remaining_vnd: 5 }, { rec_code: 3 }, { recorded_on: undefined }]) expect(toRecoveryLine(linkRecord(3, broken))).toBeUndefined();
    expect(toRecoveryLine(null)).toBeUndefined();
  });

  it('reads the money of an engagement, its two rates each with the numerator and the denominator, its recommendations with their versions and its exceptions', () => {
    const exception = { id: 'x1', recommendation_id: 'r1', rec_code: 'KN-002', kind: 'OVER_RECOVERY', source_kind: 'PAY_DEDUCTION', source_id: null, amount_vnd: '200000000', recorded_on: '2026-10-21', status: 'OPEN', created_at: 'now' };
    const summary = toRecoverySummary(summaryRecord({ exceptions: [exception, { id: 'broken' }] }));
    expect(summary).toMatchObject({
      amountVnd: '800000000',
      recoveredVnd: '500000000',
      remainingVnd: '300000000',
      moneyRate: { numerator: '500000000', denominator: '800000000', percent: '62.50' },
      countRate: { numerator: '0', denominator: '1', percent: '0.00' },
    });
    expect(summary?.recommendations).toEqual([{ recommendationId: expect.any(String), code: 'KN-001', status: 'IN_PROGRESS', amountVnd: '800000000', recoveredVnd: '500000000', remainingVnd: '300000000', lineCount: 1, version: 6 }]);
    expect(summary?.exceptions).toEqual([{ id: 'x1', recommendationId: 'r1', code: 'KN-002', kind: 'OVER_RECOVERY', sourceKind: 'PAY_DEDUCTION', amountVnd: '200000000', recordedOn: '2026-10-21' }]);
  });

  it('keeps a rate whose denominator is zero as not applicable, drops a recommendation it cannot read, and refuses a summary that is not whole', () => {
    expect(toRecoverySummary(summaryRecord({ money_rate: rateRecord('0', '0', null), recommendations: [{ recommendation_id: 'r1' }], exceptions: undefined }))).toMatchObject({ moneyRate: { percent: null }, recommendations: [], exceptions: [] });
    expect(toRecoverySummary(summaryRecord({ money_rate: rateRecord('0', '5', 'many') }))?.moneyRate.percent).toBeNull();
    for (const broken of [{ engagement_id: undefined }, { amount_vnd: 'x' }, { money_rate: null }, { count_rate: { numerator: 'a', denominator: '1' } }, { remaining_vnd: undefined }]) expect(toRecoverySummary(summaryRecord(broken))).toBeUndefined();
    expect(toRecoverySummary(undefined)).toBeUndefined();
  });

  it('reads the overview with the watch list, and drops what it cannot read', () => {
    const read = toOverview(overviewRecord({ exceptions_open: 2, engagements: [...(overviewRecord().engagements as unknown[]), { id: 'broken' }] }));
    expect(read).toMatchObject({
      engagementsOngoing: 2,
      engagementsFollowUp: 3,
      recommendationsOpen: 7,
      recommendationsOverdue: 2,
      amountVnd: '1250000000',
      recoveredVnd: '500000000',
      remainingVnd: '750000000',
      moneyRate: { percent: '40.00' },
      countRate: { numerator: '1', denominator: '8', percent: '12.50' },
      exceptionsOpen: 2,
    });
    expect(read?.engagements).toEqual([{ id: expect.any(String), code: 'TTCP-2026-001', title: 'Thanh tra đầu tư cầu số 1', status: 'FOLLOW_UP', recommendationsOpen: 4, recommendationsOverdue: 2, amountVnd: '800000000', recoveredVnd: '500000000' }]);
    expect(toOverview(overviewRecord({ engagements: undefined, exceptions_open: undefined }))).toMatchObject({ engagements: [], exceptionsOpen: 0 });
    for (const broken of [{ engagements_ongoing: 'x' }, { recommendations_overdue: undefined }, { amount_vnd: undefined }, { money_rate: undefined }, { count_rate: 3 }]) expect(toOverview(overviewRecord(broken))).toBeUndefined();
    expect(toOverview(null)).toBeUndefined();
  });
});

describe('what the caller may do', () => {
  it('shows the buttons to whoever holds the permission to record, in a tenant that is not read only', () => {
    expect(canRecordRecovery(['aud.recovery.record'], undefined)).toBe(true);
    expect(canRecordRecovery(undefined, 'FULL')).toBe(true);
    expect(canRecordRecovery(['aud.read'], 'FULL')).toBe(false);
    expect(canRecordRecovery(['aud.recovery.record'], 'READ_ONLY')).toBe(false);
  });

  it('reverses a line that adds money and was not reversed, and not a reversal or a line that was reversed', () => {
    const line = (overrides: Record<string, unknown>) => toRecoveryLine(linkRecord(1, overrides)) as NonNullable<ReturnType<typeof toRecoveryLine>>;
    expect(canReverse(line({}))).toBe(true);
    expect(canReverse(line({ reversed: true }))).toBe(false);
    expect(canReverse(line({ amount_vnd: '-5', reversal_of_id: 'a' }))).toBe(false);
    expect(canReverse(line({ amount_vnd: '-5' }))).toBe(false);
  });

  it('writes the percentage in the way the language writes it, and says nothing for a rate that is not applicable', () => {
    expect(percentText({ numerator: '1', denominator: '8', percent: '12.50' }, 'vi')).toBe('12,50%');
    expect(percentText({ numerator: '1', denominator: '8', percent: '12.50' }, 'en')).toBe('12.50%');
    expect(percentText({ numerator: '0', denominator: '0', percent: null }, 'vi')).toBeNull();
  });

  it('offers the recommendations that are not cancelled for a new line', () => {
    const items = toRecoverySummary(summaryRecord({ recommendations: [{ recommendation_id: 'a', rec_code: 'A', status: 'OPEN', amount_vnd: '1', recovered_vnd: '0', remaining_vnd: '1', line_count: 0, version: 1 }, { recommendation_id: 'b', rec_code: 'B', status: 'CANCELLED', amount_vnd: '1', recovered_vnd: '0', remaining_vnd: '1', line_count: 0, version: 1 }] }))?.recommendations ?? [];
    expect(recoverable(items).map((item) => item.code)).toEqual(['A']);
  });
});

describe('the form of a line entered by hand', () => {
  const form = (overrides: Partial<LinkForm> = {}): LinkForm => ({ recommendationId: 'r1', sourceKind: 'TREASURY_REMITTANCE', sourceId: '', amountVnd: '300.000.000', recordedOn: '2026-10-20', evidenceDocumentId: DOCUMENT, ...overrides });

  it('has nothing wrong with a full one, and the body sends the amount in whole dong, the ids in lower case and no source id when none was typed', () => {
    expect(validateLink(form(), '300000000', TODAY)).toEqual({});
    expect(linkBody(form())).toEqual({ source_kind: 'TREASURY_REMITTANCE', amount_vnd: '300000000', recorded_on: '2026-10-20', evidence_document_id: DOCUMENT });
    expect(linkBody(form({ sourceId: DOCUMENT.toUpperCase(), evidenceDocumentId: DOCUMENT.toUpperCase(), sourceKind: 'MANUAL_EVIDENCE' }))).toEqual({
      source_kind: 'MANUAL_EVIDENCE',
      source_id: DOCUMENT,
      amount_vnd: '300000000',
      recorded_on: '2026-10-20',
      evidence_document_id: DOCUMENT,
    });
  });

  it('AC-ST-AUD-004-2: refuses an amount above what is left before it is sent, to the last dong', () => {
    expect(validateLink(form({ amountVnd: '300.000.001' }), '300000000', TODAY)).toEqual({ amountVnd: 'exceeds' });
    expect(validateLink(form({ amountVnd: '1' }), '0', TODAY)).toEqual({ amountVnd: 'exceeds' });
    // while the recommendation is not chosen there is nothing to compare with
    expect(validateLink(form({ recommendationId: '', amountVnd: '999.999.999.999' }), undefined, TODAY)).toEqual({ recommendationId: 'required' });
  });

  it('says what is missing and what is wrong', () => {
    expect(validateLink(EMPTY_LINK_FORM, undefined, TODAY)).toEqual({ recommendationId: 'required', sourceKind: 'required', amountVnd: 'required', recordedOn: 'required', evidenceDocumentId: 'required' });
    expect(validateLink(form({ amountVnd: '0' }), '5', TODAY)).toEqual({ amountVnd: 'invalid' });
    expect(validateLink(form({ amountVnd: '12x' }), '5000000000', TODAY)).toEqual({ amountVnd: 'invalid' });
    expect(validateLink(form({ recordedOn: '2026-10-27' }), '300000000', TODAY)).toEqual({ recordedOn: 'future' });
    expect(validateLink(form({ recordedOn: '2026-13-40' }), '300000000', TODAY)).toEqual({ recordedOn: 'invalid' });
    expect(validateLink(form({ evidenceDocumentId: 'not-an-id', sourceId: 'x' }), '300000000', TODAY)).toEqual({ evidenceDocumentId: 'invalid', sourceId: 'invalid' });
  });
});

describe('the form of a reversal', () => {
  it('asks for the reason in words, at least ten characters', () => {
    expect(validateReverse({ reason: 'Chứng từ nhập hai lần.' })).toEqual({});
    expect(reverseBody({ reason: '  Chứng từ nhập hai lần.  ' })).toEqual({ reason: 'Chứng từ nhập hai lần.' });
    expect(validateReverse(EMPTY_REVERSE_FORM)).toEqual({ reason: 'required' });
    expect(validateReverse({ reason: 'ngắn' })).toEqual({ reason: 'tooShort' });
    expect(validateReverse({ reason: 'x'.repeat(1001) })).toEqual({ reason: 'tooLong' });
    expect(validateReverse({ reason: `${'x'.repeat(20)}\u0007` })).toEqual({ reason: 'invalid' });
    expect(validateReverse({ reason: 'dòng một đủ dài\nvà dòng hai' })).toEqual({});
  });
});

describe('what a refusal of the server comes to', () => {
  const refused = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 409, code, correlationId: 'c', extensions });

  it('names the problem of each code the commands answer, and the general one for any other', () => {
    const cases: Array<[string, string]> = [
      ['RECOVERY_EXCEEDS_RECOMMENDATION', 'exceeds'],
      ['RECOVERY_SOURCE_ALREADY_LINKED', 'sourceLinked'],
      ['RECOMMENDATION_NOT_FINANCIAL', 'notFinancial'],
      ['EVIDENCE_REQUIRED', 'evidenceRequired'],
      ['RECOVERY_ALREADY_REVERSED', 'alreadyReversed'],
      ['RECOMMENDATION_STATE_INVALID', 'recommendationState'],
      ['ENGAGEMENT_STATE_INVALID', 'engagementState'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['SCOPE_DENIED', 'scopeDenied'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, problem] of cases) expect(describeRecovery(refused(code)).problem).toBe(problem);
    expect(describeRecovery(new Error('offline'))).toEqual({ problem: 'general', remainingVnd: undefined });
  });

  it('carries what is left to recover when the amount was refused, and nothing otherwise', () => {
    expect(describeRecovery(refused('RECOVERY_EXCEEDS_RECOMMENDATION', { remaining_vnd: '20000000' }))).toEqual({ problem: 'exceeds', remainingVnd: '20000000' });
    expect(describeRecovery(refused('RECOVERY_EXCEEDS_RECOMMENDATION', { remaining_vnd: 'lots' })).remainingVnd).toBeUndefined();
    expect(describeRecovery(refused('EVIDENCE_REQUIRED', { remaining_vnd: '5' })).remainingVnd).toBeUndefined();
  });
});
