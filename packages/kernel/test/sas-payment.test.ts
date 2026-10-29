import { autoMatch, invoiceCodesIn, judgeMatch, outstandingVnd, parseEInvoiceCallback, parsePaymentCallback } from '../src/sas-payment';

const body = (value: Record<string, unknown>): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
const PAYMENT = { event_id: 'evt-1', type: 'payment.received', txn_ref: 'TXN-1', amount_vnd: '1100000', received_at: '2026-02-10T03:00:00Z', memo: 'INV-20260101-3FA85F64 thanh toan' };

describe('the payment callbacks and their matching (ST-SAS-012, SAS.md 3.7)', () => {
  describe('a payment callback', () => {
    it('reads the event, the transaction, the amount, the method, the day and the note', () => {
      expect(parsePaymentCallback(body(PAYMENT))).toEqual({ eventKey: 'evt-1', txnRef: 'TXN-1', amountVnd: '1100000', method: 'BANK_TRANSFER', receivedAt: new Date('2026-02-10T03:00:00Z'), memo: 'INV-20260101-3FA85F64 thanh toan' });
      expect(parsePaymentCallback(body({ ...PAYMENT, method: 'GATEWAY', amount_vnd: 5000 }))).toMatchObject({ method: 'GATEWAY', amountVnd: '5000' });
      expect(parsePaymentCallback(body({ ...PAYMENT, memo: '' }))).toMatchObject({ memo: '' });
    });

    it('refuses what is not a payment that came in: another type, no key, an amount that is not whole VND or not above zero, an unknown method, no day', () => {
      for (const broken of [{ type: 'payment.refunded' }, { event_id: '' }, { txn_ref: undefined }, { amount_vnd: '0' }, { amount_vnd: '-5' }, { amount_vnd: '1.5' }, { amount_vnd: 'abc' }, { amount_vnd: 1.5 }, { method: 'CASH' }, { received_at: 'yesterday' }, { received_at: undefined }, { memo: 'x'.repeat(501) }]) {
        expect(parsePaymentCallback(body({ ...PAYMENT, ...broken }))).toBeUndefined();
      }
      expect(parsePaymentCallback(Buffer.from('not json'))).toBeUndefined();
      expect(parsePaymentCallback(Buffer.from('[1,2]'))).toBeUndefined();
    });
  });

  describe('an e-invoice callback', () => {
    const EINVOICE = { event_id: 'evt-2', type: 'einvoice.issued', reference_key: '3fa85f64-5717-4562-b3fc-2c963f66afa6', template_code: '1', series: 'C26TMV', number: '0000012', tax_authority_code: 'CQT123', lookup_code: 'LK1' };

    it('reads the reference key and what the provider issued', () => {
      expect(parseEInvoiceCallback(body(EINVOICE))).toEqual({ eventKey: 'evt-2', referenceKey: EINVOICE.reference_key, templateCode: '1', series: 'C26TMV', number: '0000012', taxAuthorityCode: 'CQT123', lookupCode: 'LK1' });
    });

    it('refuses one that lacks any of them or is of another type', () => {
      for (const field of Object.keys(EINVOICE)) expect(parseEInvoiceCallback(body({ ...EINVOICE, [field]: undefined }))).toBeUndefined();
      expect(parseEInvoiceCallback(body({ ...EINVOICE, type: 'einvoice.rejected' }))).toBeUndefined();
      // The reference key is the id of an invoice: a text that is not one is refused here, before it reaches a query.
      for (const reference of ['invoice-123', '', '3fa85f64-5717-4562-b3fc-2c963f66afa', `${EINVOICE.reference_key}0`]) expect(parseEInvoiceCallback(body({ ...EINVOICE, reference_key: reference }))).toBeUndefined();
      expect(parseEInvoiceCallback(body({ ...EINVOICE, reference_key: EINVOICE.reference_key.toUpperCase() }))?.referenceKey).toBe(EINVOICE.reference_key);
    });
  });

  it('finds the codes of the invoices a note names, once each, whatever their case and the words around them', () => {
    expect(invoiceCodesIn('CK inv-20260101-3fa85f64 va INV-20260201-3FA85F64-2, INV-20260101-3FA85F64')).toEqual(['INV-20260101-3FA85F64', 'INV-20260201-3FA85F64-2']);
    expect(invoiceCodesIn('thanh toan tien thang 1')).toEqual([]);
    expect(invoiceCodesIn('INV-2026-3FA85F64 INV-20260101-XYZ')).toEqual([]);
    // Only whole codes: a longer run of letters and digits, or the front of a longer revision, is not the code it starts with.
    expect(invoiceCodesIn('INV-20260101-3FA85F640')).toEqual([]);
    expect(invoiceCodesIn('XINV-20260101-3FA85F64')).toEqual([]);
    expect(invoiceCodesIn('INV-20260101-3FA85F64-1000')).toEqual([]);
    expect(invoiceCodesIn('INV-20260101-3FA85F64-100')).toEqual(['INV-20260101-3FA85F64-100']);
    expect(invoiceCodesIn('(INV-20260101-3FA85F64), thanks')).toEqual(['INV-20260101-3FA85F64']);
  });

  it('settles an invoice only for exactly what is still to be paid', () => {
    expect(outstandingVnd('1100000', '0')).toBe('1100000');
    expect(outstandingVnd('1100000', '100000')).toBe('1000000');
    expect(judgeMatch('1100000', '1100000')).toBe('MATCH');
    expect(judgeMatch('1099999', '1100000')).toBe('AMOUNT_MISMATCH');
    expect(judgeMatch('1100001', '1100000')).toBe('AMOUNT_MISMATCH');
    expect(judgeMatch('5', '0')).toBe('AMOUNT_MISMATCH');
  });

  describe('what the matching worker does', () => {
    const candidate = (overrides: Partial<{ status: string; outstandingVnd: string }> = {}) => ({ tenantId: 't1', invoiceId: 'i1', status: 'Issued', outstandingVnd: '1100000', ...overrides });

    it('settles the one payable invoice whose outstanding amount the payment equals', () => {
      expect(autoMatch('1100000', [candidate()], 1)).toEqual({ verdict: 'MATCH', candidate: candidate() });
      expect(autoMatch('1100000', [candidate({ status: 'Overdue' })], 1).verdict).toBe('MATCH');
    });

    it('leaves a payment whose note names no invoice Unmatched', () => {
      expect(autoMatch('1100000', [], 0)).toEqual({ verdict: 'UNMATCHED' });
      expect(autoMatch('1100000', [], 1)).toEqual({ verdict: 'UNMATCHED' });
    });

    it('sends to a person a note that names several invoices, an invoice that cannot be paid, or another amount', () => {
      expect(autoMatch('1100000', [candidate(), { ...candidate(), invoiceId: 'i2' }], 2).verdict).toBe('REVIEW');
      expect(autoMatch('1100000', [candidate(), { ...candidate(), invoiceId: 'i2' }], 1).verdict).toBe('REVIEW');
      // Two codes in the note and only one that resolves: still ambiguous.
      expect(autoMatch('1100000', [candidate()], 2).verdict).toBe('REVIEW');
      expect(autoMatch('1100000', [candidate({ status: 'Draft' })], 1).verdict).toBe('REVIEW');
      expect(autoMatch('1100000', [candidate({ status: 'Paid', outstandingVnd: '0' })], 1).verdict).toBe('REVIEW');
      expect(autoMatch('900000', [candidate()], 1).verdict).toBe('REVIEW');
    });
  });
});
