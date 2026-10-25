import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { canManage, closeBody, createBody, daysLeft, describeProblem, emptyClose, emptyCreate, toWarranty, toWarrantyList, validateClose, validateCreate, vietnamToday } from './model';
import type { CreateForm } from './model';
import { GUARANTEE, handoverId, warranty, warrantyId } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });

const filled = (overrides: Partial<CreateForm> = {}): CreateForm => ({
  handoverId: handoverId(1),
  assetId: '',
  scope: ' Toàn bộ nhà bơm ',
  startsOn: '2026-09-01',
  periodMonths: ' 12 ',
  grade: 'II',
  guaranteeId: '',
  retentionVnd: ' 150000000 ',
  ...overrides,
});

describe('toWarranty', () => {
  it('reads an obligation with its term, its rule, its cover, its claims and whether it may be closed', () => {
    const read = toWarranty(
      warranty(1, {
        asset: { id: 'a', asset_code: 'AS-1', name: 'Trạm bơm' },
        guarantee: { id: GUARANTEE, guarantee_no: 'BL-1', issuer: 'Ngân hàng', amount_vnd: '500000000', expires_on: '2028-01-01' },
        status: 'EXPIRED',
        closed_at: null,
        open_claims: 1,
        total_claims: 2,
        allowed: { close: true },
      }),
    );
    expect(read).toMatchObject({
      id: warrantyId(1),
      contract: { code: 'HD-A-002' },
      handover: { id: handoverId(1), handoverNo: 'BG-001' },
      scope: 'Phạm vi bảo hành 1',
      asset: { assetCode: 'AS-1', name: 'Trạm bơm' },
      startsOn: '2026-09-01',
      endsOn: '2999-09-01',
      periodMonths: 12,
      constructionGrade: 'II',
      minimumMonths: 12,
      rule: { awaitingConfirmation: true, cxn: 'CXN-EXE-04' },
      guarantee: { guaranteeNo: 'BL-1', issuer: 'Ngân hàng', amountVnd: '500000000' },
      retentionAmountVnd: '150000000',
      status: 'EXPIRED',
      openClaims: 1,
      totalClaims: 2,
      canClose: true,
    });
  });

  it('keeps what is missing as nothing and refuses what cannot be shown', () => {
    expect(
      toWarranty({ ...warranty(1), asset: null, rule: null, guarantee: null, construction_grade: null, minimum_months: null, allowed: null, open_claims: undefined, total_claims: undefined }),
    ).toMatchObject({ asset: null, rule: null, guarantee: null, constructionGrade: null, minimumMonths: null, canClose: false, openClaims: 0, totalClaims: 0 });
    expect(
      toWarranty({ ...warranty(1), handover: null, contract: { id: 'c' }, rule: { awaiting_confirmation: false }, guarantee: {}, scope_description: undefined, retention_amount_vnd: undefined }),
    ).toMatchObject({
      handover: { id: '', handoverNo: null },
      contract: { code: '' },
      rule: { awaitingConfirmation: false, cxn: null },
      guarantee: { guaranteeNo: null, issuer: '', amountVnd: '0' },
      scope: '',
      retentionAmountVnd: '0',
    });
    expect(toWarranty({ ...warranty(1), asset: {} })).toMatchObject({ asset: { id: '', assetCode: '', name: null } });
    expect(toWarranty(null)).toBeUndefined();
    expect(toWarranty({ ...warranty(1), status: 'GONE' })).toBeUndefined();
    expect(toWarranty({ ...warranty(1), period_months: 'twelve' })).toBeUndefined();
    expect(toWarranty({ ...warranty(1), contract: {} })).toBeUndefined();
    expect(toWarranty({ ...warranty(1), id: 7 })).toBeUndefined();
    expect(toWarranty({ ...warranty(1), starts_on: undefined })).toBeUndefined();
    expect(toWarranty({ ...warranty(1), ends_on: undefined })).toBeUndefined();
    expect(toWarrantyList({ items: [warranty(1), { id: 'x' }, warranty(2)] }).map((line) => line.id)).toEqual([warrantyId(1), warrantyId(2)]);
    expect(toWarrantyList({ items: 'none' })).toEqual([]);
    expect(toWarrantyList(undefined)).toEqual([]);
  });

  it('counts the days to the last day of the warranty, and the Vietnam date of now', () => {
    expect(daysLeft('2027-09-01', '2027-08-31')).toBe(1);
    expect(daysLeft('2027-09-01', '2027-09-01')).toBe(0);
    expect(daysLeft('2027-09-01', '2027-09-04')).toBe(-3);
    expect(vietnamToday(new Date('2026-10-25T18:00:00Z'))).toBe('2026-10-26');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('creating an obligation', () => {
  it('may be done by whoever holds the permission, or when it is not yet known, unless the session is read only', () => {
    expect(canManage(['warranty.manage'], 'FULL')).toBe(true);
    expect(canManage(undefined, undefined)).toBe(true);
    expect(canManage(['warranty.manage'], 'READ_ONLY')).toBe(false);
    expect(canManage(['warranty.read'], 'FULL')).toBe(false);
  });

  it('sees what is wrong before it is sent: the handover, the scope, the start, the term in whole months and a cover', () => {
    expect(validateCreate(filled())).toEqual({});
    expect(Object.keys(validateCreate(emptyCreate())).sort()).toEqual(['periodMonths', 'retentionVnd', 'scope', 'startsOn', 'handoverId'].sort());
    expect(validateCreate(emptyCreate(handoverId(2)))).not.toHaveProperty('handoverId');
    expect(validateCreate(filled({ scope: 'x'.repeat(2001) }))).toEqual({ scope: 'tooLong' });
    expect(validateCreate(filled({ startsOn: '2026-02-30' }))).toEqual({ startsOn: 'date' });
    for (const periodMonths of ['0', '601', '12.5', '-1', 'x', '1234']) expect(validateCreate(filled({ periodMonths }))).toEqual({ periodMonths: 'period' });
    expect(validateCreate(filled({ periodMonths: '600' }))).toEqual({});
  });

  it('is covered by a guarantee or by an amount held back above nothing', () => {
    expect(validateCreate(filled({ retentionVnd: '' }))).toEqual({ retentionVnd: 'cover' });
    expect(validateCreate(filled({ retentionVnd: '0' }))).toEqual({ retentionVnd: 'cover' });
    expect(validateCreate(filled({ retentionVnd: '000' }))).toEqual({ retentionVnd: 'cover' });
    expect(validateCreate(filled({ retentionVnd: '', guaranteeId: GUARANTEE }))).toEqual({});
    expect(validateCreate(filled({ retentionVnd: '0', guaranteeId: GUARANTEE }))).toEqual({});
    expect(validateCreate(filled({ retentionVnd: '12.5' }))).toEqual({ retentionVnd: 'amount' });
    expect(validateCreate(filled({ retentionVnd: '-1', guaranteeId: GUARANTEE }))).toEqual({ retentionVnd: 'amount' });
    expect(validateCreate(filled({ guaranteeId: 'nope' }))).toEqual({ guaranteeId: 'uuid' });
  });

  it('sends the contract of the handover, the words trimmed, the term as a number and the optional fields only when given', () => {
    expect(createBody(filled(), 'contract-1')).toEqual({
      contract_id: 'contract-1',
      handover_id: handoverId(1),
      scope_description: 'Toàn bộ nhà bơm',
      starts_on: '2026-09-01',
      period_months: 12,
      construction_grade: 'II',
      retention_amount_vnd: '150000000',
    });
    expect(createBody(filled({ assetId: 'asset-1', grade: '', retentionVnd: '', guaranteeId: ` ${GUARANTEE.toUpperCase()} ` }), 'contract-1')).toEqual({
      contract_id: 'contract-1',
      handover_id: handoverId(1),
      asset_id: 'asset-1',
      scope_description: 'Toàn bộ nhà bơm',
      starts_on: '2026-09-01',
      period_months: 12,
      warranty_guarantee_id: GUARANTEE,
    });
  });
});

describe('closing an obligation', () => {
  it('takes a note of limited length, and sends it only when there is one', () => {
    expect(validateClose(emptyClose())).toEqual({});
    expect(validateClose({ note: 'x'.repeat(2001) })).toEqual({ note: 'tooLong' });
    expect(closeBody({ note: '   ' })).toEqual({});
    expect(closeBody({ note: ' Đã xử lý hết ' })).toEqual({ note: 'Đã xử lý hết' });
  });
});

describe('describeProblem', () => {
  const none = { minimum: undefined, period: undefined, endsOn: undefined, claims: [] };

  it('words every refusal the commands can meet, and keeps the figures of the term, the last day and the claims', () => {
    expect(describeProblem(problem('WARRANTY_PERIOD_BELOW_MINIMUM', { minimum_months: 12, period_months: 6 }))).toEqual({ ...none, problem: 'belowMinimum', minimum: 12, period: 6 });
    expect(describeProblem(problem('WARRANTY_PERIOD_BELOW_MINIMUM'))).toEqual({ ...none, problem: 'belowMinimum' });
    expect(describeProblem(problem('NO_EFFECTIVE_RULE'))).toEqual({ ...none, problem: 'noRule' });
    expect(describeProblem(problem('GUARANTEE_REQUIRED'))).toEqual({ ...none, problem: 'guaranteeRequired' });
    expect(describeProblem(problem('HANDOVER_NOT_ACCEPTED'))).toEqual({ ...none, problem: 'handoverNotAccepted' });
    expect(describeProblem(problem('WARRANTY_NOT_EXPIRED', { ends_on: '2027-09-01' }))).toEqual({ ...none, problem: 'notExpired', endsOn: '2027-09-01' });
    expect(describeProblem(problem('OPEN_WARRANTY_CLAIMS', { open_claims: 2, claim_nos: ['WC-1', 'WC-2', 7] }))).toEqual({ ...none, problem: 'openClaims', claims: ['WC-1', 'WC-2'] });
    expect(describeProblem(problem('OPEN_WARRANTY_CLAIMS'))).toEqual({ ...none, problem: 'openClaims' });
    expect(describeProblem(problem('WARRANTY_STATE_INVALID', {}, 409)).problem).toBe('stateInvalid');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(problem(code, {}, 400)).problem).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', {}, 404)).problem).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED', {}, 401)).problem).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE', {}, 500)).problem).toBe('general');
    expect(describeProblem(new Error('x')).problem).toBe('general');
  });
});
