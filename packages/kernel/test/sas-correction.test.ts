import { correctionDefects, judgeCorrection, priceCorrection, receivableVnd } from '../src/sas-correction';
import type { CorrectionInput } from '../src/sas-correction';

const good = (overrides: Partial<CorrectionInput> = {}): CorrectionInput => ({ reason: 'The plan was billed at the wrong price.', agreementRef: 'BB-2026/0042', lines: [{ description: 'Reduction of the plan price', amountVnd: '-36500000', vatCategory: 'NOT_SUBJECT' }], ...overrides });

describe('the correction of an issued invoice (ST-SAS-013, SAS.md 3.7 item 4)', () => {
  describe('the shape of a correction', () => {
    it('accepts a reason, an agreement reference and lines that are whole VND, not zero, with a VAT category', () => {
      expect(correctionDefects(good())).toEqual([]);
      expect(correctionDefects(good({ lines: [{ description: 'Increase', amountVnd: '5000', vatCategory: 'VAT_10' }, { description: 'Reduction', amountVnd: '-1', vatCategory: 'VAT_8' }] }))).toEqual([]);
    });

    it('names each field that is wrong: a short reason, a short agreement reference, no lines or too many', () => {
      expect(correctionDefects(good({ reason: '   short   ' }))).toEqual([{ field: 'correction_reason' }]);
      expect(correctionDefects(good({ agreementRef: ' 1234 ' }))).toEqual([{ field: 'agreement_document_ref' }]);
      expect(correctionDefects(good({ lines: [] }))).toEqual([{ field: 'lines', reason: 'EMPTY' }]);
      expect(correctionDefects(good({ lines: Array.from({ length: 51 }, () => ({ description: 'x', amountVnd: '1', vatCategory: 'NOT_SUBJECT' })) }))).toEqual([{ field: 'lines', reason: 'TOO_MANY' }]);
    });

    it('names the line that is wrong and why: no description, an amount that is not whole VND, zero, an unknown VAT category', () => {
      const line = (overrides: Record<string, string>) => ({ description: 'x', amountVnd: '10', vatCategory: 'VAT_10', ...overrides });
      expect(correctionDefects(good({ lines: [line({ description: '  ' })] }))).toEqual([{ field: 'lines', index: 0, reason: 'DESCRIPTION' }]);
      expect(correctionDefects(good({ lines: [line({}), line({ amountVnd: '1.5' })] }))).toEqual([{ field: 'lines', index: 1, reason: 'AMOUNT' }]);
      expect(correctionDefects(good({ lines: [line({ amountVnd: '0' })] }))).toEqual([{ field: 'lines', index: 0, reason: 'ZERO' }]);
      expect(correctionDefects(good({ lines: [line({ vatCategory: 'VAT_7' })] }))).toEqual([{ field: 'lines', index: 0, reason: 'VAT' }]);
    });
  });

  it('prices a correction as an invoice is priced: the VAT of each line rounded half up, a reduction mirroring it, the total the subtotal plus the VAT', () => {
    expect(priceCorrection('ADJUSTMENT', [{ description: 'Reduction', amountVnd: '-36500000', vatCategory: 'NOT_SUBJECT' }])).toMatchObject({ subtotalVnd: '-36500000', vatVnd: '0', totalVnd: '-36500000' });
    const mixed = priceCorrection('ADJUSTMENT', [{ description: 'Up', amountVnd: '7', vatCategory: 'VAT_8' }, { description: 'Down', amountVnd: '-7', vatCategory: 'VAT_8' }]);
    expect(mixed).toMatchObject({ subtotalVnd: '0', vatVnd: '0', totalVnd: '0' });
    expect(priceCorrection('REPLACEMENT', [{ description: 'Plan', amountVnd: '1000000', vatCategory: 'VAT_10' }]).lines[0]).toMatchObject({ kind: 'SUBSCRIPTION', vatVnd: '100000' });
    expect(priceCorrection('ADJUSTMENT', [{ description: 'x', amountVnd: '1', vatCategory: 'VAT_10' }]).lines[0]?.kind).toBe('ADJUSTMENT');
  });

  describe('the totals of a correction', () => {
    it('lets an adjustment change what the invoice stands for, up or down, and not make it a debt of the seller', () => {
      expect(judgeCorrection('ADJUSTMENT', '-36500000', '365000000')).toBeUndefined();
      expect(judgeCorrection('ADJUSTMENT', '1', '365000000')).toBeUndefined();
      expect(judgeCorrection('ADJUSTMENT', '-365000000', '365000000')).toBeUndefined();
      expect(judgeCorrection('ADJUSTMENT', '-365000001', '365000000')).toBe('ADJUSTMENT_BELOW_ZERO');
      expect(judgeCorrection('ADJUSTMENT', '0', '365000000')).toBe('ADJUSTMENT_ZERO');
    });

    it('lets a replacement be for more than nothing only, so that replacing is not cancelling', () => {
      expect(judgeCorrection('REPLACEMENT', '328500000', '365000000')).toBeUndefined();
      expect(judgeCorrection('REPLACEMENT', '0', '365000000')).toBe('REPLACEMENT_NOT_ABOVE_ZERO');
      expect(judgeCorrection('REPLACEMENT', '-5', '365000000')).toBe('REPLACEMENT_NOT_ABOVE_ZERO');
    });
  });

  describe('what the buyer owes', () => {
    it('does not count the adjustments of an invoice that was replaced: the replacement already has what they said', () => {
      const invoices = [
        { id: 'o', kind: 'ORIGINAL', status: 'Replaced', totalVnd: '365000000' },
        { id: 'a', kind: 'ADJUSTMENT', status: 'Issued', totalVnd: '-36500000', relatedInvoiceId: 'o' },
        { id: 'r', kind: 'REPLACEMENT', status: 'Issued', totalVnd: '328500000', relatedInvoiceId: 'o' },
      ];
      expect(receivableVnd(invoices, '0')).toBe('328500000');
    });

    it('is the original less the reduction, less what was paid: 365,000,000 less 36,500,000 is 328,500,000', () => {
      const invoices = [{ id: 'o', kind: 'ORIGINAL', status: 'Adjusted', totalVnd: '365000000' }, { id: 'a', kind: 'ADJUSTMENT', status: 'Issued', totalVnd: '-36500000', relatedInvoiceId: 'o' }];
      expect(receivableVnd(invoices, '0')).toBe('328500000');
      expect(receivableVnd(invoices, '100000000')).toBe('228500000');
    });

    it('leaves out an original that was replaced and counts its replacement instead, and leaves out what is not issued', () => {
      const invoices = [
        { id: 'o', kind: 'ORIGINAL', status: 'Replaced', totalVnd: '365000000' },
        { id: 'r', kind: 'REPLACEMENT', status: 'Issued', totalVnd: '328500000', relatedInvoiceId: 'o' },
        { id: 'd1', kind: 'ADJUSTMENT', status: 'Draft', totalVnd: '-5', relatedInvoiceId: 'r' },
        { id: 'd2', kind: 'ADJUSTMENT', status: 'PendingIssue', totalVnd: '-5', relatedInvoiceId: 'r' },
        { id: 'd3', kind: 'ADJUSTMENT', status: 'Discarded', totalVnd: '-5', relatedInvoiceId: 'r' },
        { id: 'd4', kind: 'REPLACEMENT', status: 'IssueFailed', totalVnd: '999', relatedInvoiceId: 'r' },
      ];
      expect(receivableVnd(invoices, '0')).toBe('328500000');
    });
  });
});
