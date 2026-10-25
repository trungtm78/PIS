import { EXTENSION_REASON_CODES, extensionIssues, extensionWindow, undisbursedVnd } from '../src/allocation-extension';

const valid = { amountVnd: '3000000000', extendedTo: '2026-01-31', reasonCode: 'GPMB_CHAM', fromPlanYear: 2025 };

describe('the rules of a request to carry capital over (ST-CAP-007)', () => {
  it('accepts a request inside the year after the plan year', () => {
    expect(extensionIssues(valid)).toEqual([]);
    expect(extensionIssues({ ...valid, extendedTo: '2026-12-31' })).toEqual([]);
    expect(extensionIssues({ ...valid, extendedTo: '2026-01-01', justification: 'Mặt bằng chưa bàn giao do vướng hộ dân' })).toEqual([]);
  });

  it('knows the window: the whole year after the plan year', () => {
    expect(extensionWindow(2025)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('refuses an amount that is not whole VND above zero', () => {
    for (const amountVnd of ['0', '-5', '1.5', '1e9', '', '0100', '9'.repeat(25)]) expect(extensionIssues({ ...valid, amountVnd })).toEqual([{ field: 'amount_vnd', reason: 'AMOUNT_INVALID' }]);
    expect(extensionIssues({ ...valid, amountVnd: '9'.repeat(24) })).toEqual([]);
  });

  it('refuses a day that is not a calendar day, or lies outside the year after the plan year', () => {
    for (const extendedTo of ['', '31/01/2026', '2026-02-30', '2026-13-01', '2026-1-1']) expect(extensionIssues({ ...valid, extendedTo })).toEqual([{ field: 'extended_to', reason: 'DATE_INVALID' }]);
    expect(extensionIssues({ ...valid, extendedTo: '2025-12-31' })).toEqual([{ field: 'extended_to', reason: 'EXTENDED_TO_TOO_EARLY' }]);
    expect(extensionIssues({ ...valid, extendedTo: '2027-01-01' })).toEqual([{ field: 'extended_to', reason: 'EXTENDED_TO_TOO_LATE' }]);
  });

  it('asks for one of the four reasons, and for words when the reason is KHAC or when words are given', () => {
    expect(EXTENSION_REASON_CODES).toEqual(['GPMB_CHAM', 'VUONG_MAC_PHAP_LY', 'THIEN_TAI_DICH_BENH', 'KHAC']);
    expect(extensionIssues({ ...valid, reasonCode: 'WHIM' })).toEqual([{ field: 'reason_code', reason: 'REASON_UNKNOWN' }]);
    expect(extensionIssues({ ...valid, reasonCode: 'KHAC' })).toEqual([{ field: 'justification', reason: 'JUSTIFICATION_REQUIRED' }]);
    expect(extensionIssues({ ...valid, reasonCode: 'KHAC', justification: '   ' })).toEqual([{ field: 'justification', reason: 'JUSTIFICATION_REQUIRED' }]);
    expect(extensionIssues({ ...valid, justification: 'too short' })).toEqual([{ field: 'justification', reason: 'JUSTIFICATION_LENGTH' }]);
    expect(extensionIssues({ ...valid, justification: 'x'.repeat(2001) })).toEqual([{ field: 'justification', reason: 'JUSTIFICATION_LENGTH' }]);
    expect(extensionIssues({ ...valid, reasonCode: 'KHAC', justification: 'Đề nghị kéo dài do thay đổi thiết kế' })).toEqual([]);
  });

  it('reports every problem, in the order of the form', () => {
    expect(extensionIssues({ amountVnd: '0', extendedTo: 'x', reasonCode: 'KHAC', fromPlanYear: 2025 }).map((issue) => issue.field)).toEqual(['amount_vnd', 'extended_to', 'justification']);
  });

  it('refuses a day that does not exist even when it is well formed', () => {
    expect(extensionIssues({ ...valid, fromPlanYear: 2023, extendedTo: '2024-02-29' })).toEqual([]);
    expect(extensionIssues({ ...valid, extendedTo: '2026-04-31' })).toEqual([{ field: 'extended_to', reason: 'DATE_INVALID' }]);
  });

  it('works out what is left to carry over: allocated less committed and disbursed and less the other open requests, never below zero (UAT-PLAN-61)', () => {
    const figures = { allocatedVnd: '10000000000', committedVnd: '3000000000', disbursedVnd: '4000000000' };
    expect(undisbursedVnd(figures)).toBe('3000000000');
    expect(undisbursedVnd(figures, '1000000000')).toBe('2000000000');
    expect(undisbursedVnd(figures, '3000000000')).toBe('0');
    expect(undisbursedVnd(figures, '9000000000')).toBe('0');
    expect(undisbursedVnd({ allocatedVnd: '0', committedVnd: '0', disbursedVnd: '0' })).toBe('0');
  });
});
