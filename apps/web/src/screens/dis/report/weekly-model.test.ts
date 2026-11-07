import { describe, expect, it } from 'vitest';
import { billionsOf, canSubmit, csvOf, deadlineOf, dueMoment, markedCells, nextStepOf, periodProgressOf, ratioOf, receiptOf, returnedOf, statusTone, totalsOfLines } from './weekly-model';
import type { ReportDetail, ReportLine } from './model';

// 2027-01-08 10:00 UTC is 17:00 on Friday in Vietnam: the deadline of the week.
const DEADLINE = '2027-01-08T10:00:00.000Z';
const at = (iso: string): number => Date.parse(iso);

describe('deadlineOf', () => {
  it('counts whole calendar days of the Vietnam clock and warns on the last day and the day before', () => {
    expect(deadlineOf(DEADLINE, at('2027-01-05T03:00:00.000Z'))).toEqual({ kind: 'open', days: 3, tone: 'default' });
    expect(deadlineOf(DEADLINE, at('2027-01-07T03:00:00.000Z'))).toEqual({ kind: 'open', days: 1, tone: 'warning' });
    expect(deadlineOf(DEADLINE, at('2027-01-08T03:00:00.000Z'))).toEqual({ kind: 'open', days: 0, tone: 'warning' });
  });

  it('is late from the deadline on, and counts the days late', () => {
    expect(deadlineOf(DEADLINE, at('2027-01-08T10:00:00.000Z'))).toEqual({ kind: 'late', days: 0, tone: 'danger' });
    expect(deadlineOf(DEADLINE, at('2027-01-11T03:00:00.000Z'))).toEqual({ kind: 'late', days: 3, tone: 'danger' });
  });

  it('gives nothing for a deadline that is not a moment', () => {
    expect(deadlineOf('later', 0)).toBeUndefined();
  });

  it('writes the deadline in Vietnam time', () => {
    expect(dueMoment(DEADLINE)).toBe('17:00 08/01/2027');
    expect(dueMoment('later')).toBe('later');
  });
});

describe('periodProgressOf', () => {
  it('gives sent, total, what is missing and the percentage', () => {
    expect(periodProgressOf({ mustReport: 8, submitted: 6 })).toEqual({ sent: 6, total: 8, missing: 2, percent: 75 });
    expect(periodProgressOf({ mustReport: 3, submitted: 1 })).toEqual({ sent: 1, total: 3, missing: 2, percent: 33 });
  });

  it('gives no percentage when no project must report, and never more sent than due', () => {
    expect(periodProgressOf({ mustReport: 0, submitted: 0 })).toEqual({ sent: 0, total: 0, missing: 0, percent: null });
    expect(periodProgressOf({ mustReport: 2, submitted: 5 })).toMatchObject({ sent: 2, missing: 0, percent: 100 });
  });
});

describe('figures', () => {
  it('writes billions with two decimals and a comma, and keeps the sign', () => {
    expect(billionsOf('1250000000')).toBe('1,25');
    expect(billionsOf('0')).toBe('0,00');
    expect(billionsOf('214710000000')).toBe('214,71');
    expect(billionsOf('1234567890000000')).toBe('1.234.567,89');
    expect(billionsOf('-1250000000')).toBe('-1,25');
    expect(billionsOf('-1000')).toBe('0,00');
  });

  it('gives the ratio in tenths of a percent, none against nothing', () => {
    expect(ratioOf('1', '3')).toBe('33,3');
    expect(ratioOf('203', '100')).toBe('203,0');
    expect(ratioOf('5', '0')).toBeNull();
  });

  it('adds up the rows that are shown', () => {
    const line = (cumulativeVnd: string, ctmtqgVnd: string): ReportLine => ({ cumulativeVnd, ctmtqgVnd }) as ReportLine;
    expect(totalsOfLines([line('420000000', '40000000'), line('1250000000', '0')])).toEqual({ cumulativeVnd: '1670000000', ctmtqgVnd: '40000000' });
    expect(totalsOfLines([])).toEqual({ cumulativeVnd: '0', ctmtqgVnd: '0' });
  });
});

describe('status', () => {
  it('has a tone for every status, and a next step', () => {
    expect(statusTone('ACCEPTED')).toBe('success');
    expect(statusTone('RETURNED')).toBe('warning');
    expect(statusTone('SUBMITTED')).toBe('info');
    expect(statusTone('DRAFT')).toBe('neutral');
    expect(nextStepOf('RETURNED')).toBe('fixReturned');
    expect(nextStepOf('DRAFT')).toBe('finishDraft');
    expect(nextStepOf('UNDER_REVIEW')).toBe('wait');
    expect(nextStepOf('ACCEPTED')).toBe('done');
  });

  it('lets a draft be handed in by a holder of the permission in a tenant that is not read only', () => {
    expect(canSubmit(['report.submit'], 'FULL', 'DRAFT')).toBe(true);
    expect(canSubmit(undefined, undefined, 'DRAFT')).toBe(true);
    expect(canSubmit(['report.edit'], 'FULL', 'DRAFT')).toBe(false);
    expect(canSubmit(['report.submit'], 'READ_ONLY', 'DRAFT')).toBe(false);
    expect(canSubmit(['report.submit'], 'FULL', 'SUBMITTED')).toBe(false);
  });
});

const decision = (overrides: Record<string, unknown>) => ({
  id: 'd',
  decision: 'RETURNED',
  reason: 'Thiếu chứng từ',
  evidenceIds: [],
  returnItems: ['Bổ sung ủy nhiệm chi'],
  dueAt: '2027-01-12T10:00:00.000Z',
  decidedBy: 'x',
  decidedAt: '2027-01-09T03:00:00.000Z',
  ...overrides,
});

describe('returnedOf', () => {
  it('takes the latest decision that sent the report back, with what is to be fixed and by when', () => {
    const detail = { status: 'RETURNED', returnedReason: 'cũ', decisions: [decision({ id: '1', reason: 'Lần một' }), decision({ id: '2', reason: 'Lần hai' })] } as unknown as ReportDetail;
    expect(returnedOf(detail)).toEqual({ reason: 'Lần hai', items: ['Bổ sung ủy nhiệm chi'], dueAt: '2027-01-12T10:00:00.000Z', decidedAt: '2027-01-09T03:00:00.000Z' });
  });

  it('falls back to the reason the report carries, and gives nothing for a report that was never sent back', () => {
    expect(returnedOf({ status: 'RETURNED', returnedReason: 'Sai số', decisions: [] })).toEqual({ reason: 'Sai số', items: [], dueAt: null, decidedAt: '' });
    expect(returnedOf({ status: 'DRAFT', returnedReason: null, decisions: [] })).toBeUndefined();
  });
});

describe('markedCells', () => {
  it('marks the cells that an error or a warning of the review names', () => {
    const review = {
      blocking: true,
      errors: [{ code: 'X', field: 'funding_lines[0].cumulative_vnd', values: {} }],
      warnings: [
        { code: 'Y', field: 'funding_lines[3].ctmtqg_subset_vnd', values: {} },
        { code: 'Z', field: 'progress.percent', values: {} },
      ],
    };
    expect([...markedCells({ review })].sort()).toEqual(['CARRYOVER:LOCAL', 'CURRENT_YEAR:CENTRAL']);
    expect(markedCells({ review: null }).size).toBe(0);
  });
});

describe('receiptOf', () => {
  it('builds the receipt from the seal and the time the server gives', () => {
    const receipt = receiptOf({ payload_hash: 'abcdef0123456789', submitted_at: '2027-01-08T09:00:00.000Z', is_late: false, period_delta_vnd: '120000000', warnings: [{ code: 'W' }] });
    expect(receipt).toEqual({ code: 'BN-ABCDEF01', submittedAt: '2027-01-08T09:00:00.000Z', isLate: false, payloadHash: 'abcdef0123456789', periodDeltaVnd: '120000000', warnings: 1 });
  });

  it('gives none for an answer that is not a receipt', () => {
    expect(receiptOf({ status: 'OK' })).toBeUndefined();
    expect(receiptOf(null)).toBeUndefined();
  });
});

describe('csvOf', () => {
  it('quotes every cell, doubles the quotes and ends the rows with the Windows line end after a byte order mark', () => {
    expect(csvOf(['Mã', 'Tên'], [['DA-1', 'Cầu "A", đường']])).toBe('﻿"Mã","Tên"\r\n"DA-1","Cầu ""A"", đường"\r\n');
  });

  it('keeps a text that a spreadsheet would run as a formula as text', () => {
    expect(csvOf(['x'], [['=1+1'], ['-5'], ['@sum'], ['+1']])).toBe('﻿"x"\r\n"\'=1+1"\r\n"\'-5"\r\n"\'@sum"\r\n"\'+1"\r\n');
  });
});
