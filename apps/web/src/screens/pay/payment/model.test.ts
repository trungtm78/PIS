import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  DOC_KINDS,
  EMPTY_ATTACH,
  EMPTY_CANCEL,
  EMPTY_CREATE,
  EMPTY_RETURN,
  EMPTY_VERIFY,
  KINDS,
  STATUSES,
  attachBody,
  canCreate,
  cancelBody,
  createBody,
  createLink,
  describeProblem,
  isEditable,
  isInvoiceDuplicate,
  listLink,
  paymentLink,
  percentText,
  returnBody,
  reviseBody,
  reviseFormOf,
  submitBody,
  toAnswer,
  toPaymentRequest,
  validateAttach,
  validateCancel,
  validateCreate,
  validateReturn,
  validateRevise,
  validateVerify,
  verifyBody,
  valuationLink,
} from './model';
import type { AttachForm, CreateForm } from './model';
import { answer, contractId, paymentDocument, payment, paymentId, paymentLine } from './test-support';

const refusal = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const create = (overrides: Partial<CreateForm> = {}): CreateForm => ({ ...EMPTY_CREATE, contractId: contractId(1), acceptanceId: 'a', allocationLineId: 'l', requestNo: 'DNTT-1', ...overrides });
const attach = (overrides: Partial<AttachForm> = {}): AttachForm => ({ ...EMPTY_ATTACH, documentId: paymentDocument(1).document_version_id, docKind: 'OTHER', ...overrides });

describe('the model of the payment request (PAY-01, PAY-02, PAY-03, CTR-13)', () => {
  it('links to the list, the form, the detail and the valuation', () => {
    expect(listLink()).toBe('/pay/pay-01');
    expect(listLink(contractId(1))).toBe(`/pay/pay-01?contract=${contractId(1)}`);
    expect(createLink()).toBe('/pay/pay-02');
    expect(createLink(contractId(1))).toBe(`/pay/pay-02?contract=${contractId(1)}`);
    expect(paymentLink(paymentId(1))).toBe(`/pay/pay-03?request=${paymentId(1)}`);
    expect(valuationLink(paymentId(1))).toBe(`/ctr/ctr-13?request=${paymentId(1)}`);
    expect(STATUSES).toHaveLength(8);
    expect(KINDS).toHaveLength(3);
    expect(DOC_KINDS).toHaveLength(6);
  });

  it('reads a request with exact amounts, its lines, its documents and what the caller may do', () => {
    const read = toPaymentRequest(payment(1, { documents: [paymentDocument(1), paymentDocument(2, { doc_kind: 'OTHER', invoice_no: null, invoice_date: null })], actions: { revise: true, attach_document: false, cancel: true, override_duplicate: true } }));
    expect(read).toMatchObject({
      id: paymentId(1),
      requestNo: 'DNTT-001',
      requestKind: 'INTERIM',
      status: 'DRAFT',
      contract: { id: contractId(1), code: 'HD-A-001', status: 'ACTIVE' },
      acceptance: { acceptanceNo: 'NT-001', acceptedOn: '2026-07-25' },
      planYear: 2026,
      grossVnd: '3000000000',
      advanceRecoveryVnd: '750000000',
      retentionVnd: '150000000',
      taxAdjustmentVnd: '0',
      netVnd: '2100000000',
      otherDrafts: 0,
      version: 1,
      actions: { revise: true, attachDocument: false, cancel: true, overrideDuplicate: true },
    });
    expect(read?.lines.map((line) => [line.businessKey, line.grossVnd, line.advanceRecoveryVnd, line.retentionVnd, line.netVnd, line.quantity, line.unitPrice])).toEqual([
      ['B01', '2000000000', '500000000', '100000000', '1400000000', '2000.000000', '1000000.000000'],
      ['B02', '1000000000', '250000000', '50000000', '700000000', '500.000000', '2000000.000000'],
    ]);
    expect(read?.documents.map((item) => [item.docKind, item.invoiceNo, item.signed])).toEqual([
      ['INVOICE', 'HD-0001234', true],
      ['OTHER', null, true],
    ]);
  });

  it('keeps the sign of a tax adjustment and drops what is not a request, a line or a document', () => {
    expect(toPaymentRequest(payment(1, { tax_adjustment_vnd: '-1000000', net_vnd: '2099000000' }))).toMatchObject({ taxAdjustmentVnd: '-1000000', netVnd: '2099000000' });
    const read = toPaymentRequest(payment(1, { lines: [paymentLine(1), { id: 'x' }, paymentLine(2, { gross_vnd: '1.5' })], documents: [paymentDocument(1), { id: 'y' }, paymentDocument(2, { doc_kind: 'NOPE' })] }));
    expect(read?.lines).toHaveLength(1);
    expect(read?.documents).toHaveLength(1);
    expect(toPaymentRequest(null)).toBeUndefined();
    expect(toPaymentRequest({ id: 'x' })).toBeUndefined();
    expect(toPaymentRequest(payment(1, { status: 'NOPE' }))).toBeUndefined();
    expect(toPaymentRequest(payment(1, { request_kind: 'NOPE' }))).toBeUndefined();
    expect(toPaymentRequest(payment(1, { gross_vnd: 'x' }))).toBeUndefined();
    expect(toPaymentRequest(payment(1, { version: 'x' }))).toBeUndefined();
    expect(toPaymentRequest(payment(1, { contract: null }))).toBeUndefined();
    const sparse = toPaymentRequest(payment(1, { acceptance: null, other_drafts: null, plan_year: null, lines: 'x', documents: 'y', actions: null, request_no: null, advance_recovery_extra_vnd: 'x' }));
    expect(sparse).toMatchObject({ acceptance: null, otherDrafts: null, planYear: null, lines: [], documents: [], requestNo: null, advanceRecoveryExtraVnd: '0', actions: { revise: false, attachDocument: false, cancel: false, overrideDuplicate: false } });
  });

  it('reads what a command answered: the figures the server computed and the warnings it knows', () => {
    expect(toAnswer(answer(1, { warnings: [{ code: 'OTHER_DRAFTS_FOR_ACCEPTANCE', detail: {} }, { code: 'NOPE', detail: {} }, { code: 'DUPLICATE_INVOICE_OTHER_CONTRACT', detail: {} }] }))).toEqual({
      id: paymentId(1),
      status: 'DRAFT',
      version: 1,
      grossVnd: '3000000000',
      advanceRecoveryVnd: '750000000',
      retentionVnd: '150000000',
      taxAdjustmentVnd: '0',
      netVnd: '2100000000',
      warnings: ['OTHER_DRAFTS_FOR_ACCEPTANCE', 'DUPLICATE_INVOICE_OTHER_CONTRACT'],
    });
    expect(toAnswer({ ...answer(1), warnings: undefined })?.warnings).toEqual([]);
    expect(toAnswer(null)).toBeUndefined();
    expect(toAnswer({ ...answer(1), net_vnd: 'x' })).toBeUndefined();
    expect(toAnswer({ ...answer(1), resource_id: undefined })).toBeUndefined();
    expect(toAnswer({ ...answer(1), status: undefined })?.status).toBe('');
  });

  it('knows who may draw up (a right, and not a read-only session) and when a request is open to change', () => {
    expect(canCreate(['payment.create'], 'FULL')).toBe(true);
    expect(canCreate(['payment.create'], undefined)).toBe(true);
    expect(canCreate(['payment.create'], 'READ_ONLY')).toBe(false);
    expect(canCreate(['payment_request.read'], 'FULL')).toBe(false);
    expect(canCreate(undefined, 'FULL')).toBe(false);
    expect(STATUSES.filter(isEditable)).toEqual(['DRAFT', 'RETURNED']);
    expect(percentText('5.0000')).toBe('5');
    expect(percentText('7.5000')).toBe('7.5');
    expect(percentText('12')).toBe('12');
  });

  it('validates the form of a request and sends only what the client decides', () => {
    expect(validateCreate(create())).toEqual({});
    expect(Object.keys(validateCreate(EMPTY_CREATE)).sort()).toEqual(['acceptanceId', 'allocationLineId', 'contractId', 'requestNo']);
    expect(validateCreate(create({ requestNo: 'x'.repeat(101) }))).toEqual({ requestNo: 'tooLong' });
    expect(validateCreate(create({ taxAdjustment: '1.5' }))).toEqual({ taxAdjustment: 'amount' });
    expect(validateCreate(create({ taxAdjustment: '-5' }))).toEqual({ taxBasis: 'required' });
    expect(validateCreate(create({ taxAdjustment: '0' }))).toEqual({});
    expect(validateCreate(create({ taxAdjustment: '-5', taxBasis: 'x'.repeat(2001) }))).toEqual({ taxBasis: 'tooLong' });
    expect(validateCreate(create({ extraRecovery: '-1' }))).toEqual({ extraRecovery: 'amount' });
    expect(createBody(create())).toEqual({ contract_id: contractId(1), request_kind: 'INTERIM', acceptance_id: 'a', allocation_line_id: 'l', request_no: 'DNTT-1' });
    expect(createBody(create({ requestNo: ' DNTT-2 ', taxAdjustment: ' -1000000 ', taxBasis: ' Thuế ', extraRecovery: ' 100 ' }))).toEqual({
      contract_id: contractId(1),
      request_kind: 'INTERIM',
      acceptance_id: 'a',
      allocation_line_id: 'l',
      request_no: 'DNTT-2',
      tax_adjustment_vnd: '-1000000',
      tax_adjustment_basis: 'Thuế',
      advance_recovery_extra_vnd: '100',
    });
    // An adjustment of nothing is not sent, and the body never carries the amounts the server computes.
    expect(Object.keys(createBody(create({ taxAdjustment: '0', taxBasis: 'x' })))).not.toContain('tax_adjustment_vnd');
    for (const field of ['gross_vnd', 'net_vnd', 'status', 'claims_acceptance']) expect(Object.keys(createBody(create({ extraRecovery: '5' })))).not.toContain(field);
  });

  it('revises from the form of the request as it stands, and sends the whole of what the client decides', () => {
    const request = toPaymentRequest(payment(1, { tax_adjustment_vnd: '-3000', tax_adjustment_basis: 'Điều chỉnh', advance_recovery_extra_vnd: '10' }))!;
    const form = reviseFormOf(request);
    expect(form).toEqual({ requestNo: 'DNTT-001', allocationLineId: request.allocationLineId, taxAdjustment: '-3000', taxBasis: 'Điều chỉnh', extraRecovery: '10' });
    expect(validateRevise(form)).toEqual({});
    expect(reviseBody(form)).toEqual({ allocation_line_id: request.allocationLineId, request_no: 'DNTT-001', tax_adjustment_vnd: '-3000', tax_adjustment_basis: 'Điều chỉnh', advance_recovery_extra_vnd: '10' });
    const plain = reviseFormOf(toPaymentRequest(payment(1, { request_no: null, allocation_line_id: null }))!);
    expect(plain).toEqual({ requestNo: '', allocationLineId: '', taxAdjustment: '', taxBasis: '', extraRecovery: '' });
    expect(Object.keys(validateRevise(plain)).sort()).toEqual(['allocationLineId', 'requestNo']);
    expect(reviseBody({ ...form, taxAdjustment: '', taxBasis: '', extraRecovery: '' })).toEqual({ allocation_line_id: request.allocationLineId, request_no: 'DNTT-001', tax_adjustment_vnd: '0', advance_recovery_extra_vnd: '0' });
    expect(validateRevise({ ...form, taxAdjustment: '5', taxBasis: '' })).toEqual({ taxBasis: 'required' });
    expect(validateRevise({ ...form, extraRecovery: 'x' })).toEqual({ extraRecovery: 'amount' });
  });

  it('validates a document: an invoice names its number and date, and the identifier must be one', () => {
    expect(validateAttach(attach())).toEqual({});
    expect(Object.keys(validateAttach(EMPTY_ATTACH)).sort()).toEqual(['docKind', 'documentId']);
    expect(validateAttach(attach({ documentId: 'x' }))).toEqual({ documentId: 'uuid' });
    expect(validateAttach(attach({ docKind: 'INVOICE' }))).toEqual({ invoiceNo: 'required', invoiceDate: 'required' });
    expect(validateAttach(attach({ docKind: 'INVOICE', invoiceNo: 'HD-1', invoiceDate: '2026/07/01' }))).toEqual({ invoiceDate: 'date' });
    expect(validateAttach(attach({ docKind: 'INVOICE', invoiceNo: 'HD-1', invoiceDate: '2026-07-01', overrideReason: 'x'.repeat(2001) }))).toEqual({ overrideReason: 'tooLong' });
    expect(attachBody(attach({ documentId: ` ${paymentDocument(1).document_version_id.toUpperCase()} ` }))).toEqual({ document_version_id: paymentDocument(1).document_version_id, doc_kind: 'OTHER' });
    expect(attachBody(attach({ docKind: 'INVOICE', invoiceNo: ' HD-1 ', invoiceDate: '2026-07-01', signed: true, overrideReason: ' Điều chỉnh ' }))).toEqual({
      document_version_id: paymentDocument(1).document_version_id,
      doc_kind: 'INVOICE',
      invoice_no: 'HD-1',
      invoice_date: '2026-07-01',
      signed: true,
      duplicate_override_reason: 'Điều chỉnh',
    });
    expect(attachBody({ ...EMPTY_ATTACH, documentId: paymentDocument(1).document_version_id })).toMatchObject({ doc_kind: 'OTHER' });
    // A reason is for an invoice only.
    expect(attachBody(attach({ docKind: 'OTHER', overrideReason: 'x' }))).not.toHaveProperty('duplicate_override_reason');
  });

  it('asks for a reason to cancel', () => {
    expect(validateCancel(EMPTY_CANCEL)).toEqual({ reason: 'required' });
    expect(validateCancel({ reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
    expect(validateCancel({ reason: 'Duplicate' })).toEqual({});
    expect(cancelBody({ reason: ' Duplicate ' })).toEqual({ reason: 'Duplicate' });
  });

  it('UI-PAY-03: sends the figures the person saw, a note that may be left out and a reason that may not', () => {
    const request = toPaymentRequest(payment(1, { verification_note: 'Complete.' }))!;
    expect(request.verificationNote).toBe('Complete.');
    expect(submitBody(request)).toEqual({ expected_gross_vnd: '3000000000', expected_net_vnd: '2100000000' });
    expect(validateVerify(EMPTY_VERIFY)).toEqual({});
    expect(validateVerify({ note: '   ' })).toEqual({ note: 'required' });
    expect(validateVerify({ note: 'x'.repeat(2001) })).toEqual({ note: 'tooLong' });
    expect(verifyBody(EMPTY_VERIFY)).toEqual({});
    expect(verifyBody({ note: ' Complete ' })).toEqual({ note: 'Complete' });
    expect(validateReturn(EMPTY_RETURN)).toEqual({ reason: 'required' });
    expect(validateReturn({ reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
    expect(validateReturn({ reason: 'Wrong invoice' })).toEqual({});
    expect(returnBody({ reason: ' Wrong invoice ' })).toEqual({ reason: 'Wrong invoice' });
    const open = toPaymentRequest(payment(1, { status: 'SUBMITTED', actions: { revise: false, attach_document: false, cancel: false, override_duplicate: false, submit: true, verify: true, return: true } }))!;
    expect(open.actions).toMatchObject({ submit: true, verify: true, return: true });
    expect(toPaymentRequest(payment(1, { actions: null }))!.actions).toMatchObject({ submit: false, verify: false, return: false });
  });

  it('words every refusal of the server', () => {
    const cases: Array<[string, string]> = [
      ['ACCEPTANCE_NOT_APPROVED', 'acceptanceNotApproved'],
      ['ACCEPTANCE_ALREADY_CLAIMED', 'claimed'],
      ['CONTRACT_STATE_INVALID', 'contractState'],
      ['PAYMENT_REFERENCE_DUPLICATE', 'referenceDuplicate'],
      ['PAYMENT_STATE_INVALID', 'paymentState'],
      ['PAYMENT_NET_MISMATCH', 'netMismatch'],
      ['INVOICE_REQUIRED', 'invoiceRequired'],
      ['VALUE_EXCEEDED', 'valueExceeded'],
      ['ADVANCE_RECOVERY_EXCEEDED', 'advanceExceeded'],
      ['ALLOCATION_UNAVAILABLE', 'allocationUnavailable'],
      ['DISBURSEMENT_PROJECT_NOT_LISTED', 'disbursementNotListed'],
      ['DISBURSEMENT_NO_APPROVED_PLAN', 'disbursementNoPlan'],
      ['PLAN_YEAR_MISMATCH', 'planYear'],
      ['NATIONAL_CODE_REQUIRED', 'nationalCode'],
      ['NATIONAL_CODE_FORMAT_INVALID', 'nationalCode'],
      ['INVOICE_DUPLICATE', 'invoiceDuplicate'],
      ['DOCUMENT_NOT_CLEAN', 'documentNotClean'],
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, problem] of cases) expect(describeProblem(refusal(code))).toBe(problem);
    expect(describeProblem(new Error('x'))).toBe('general');
    expect(isInvoiceDuplicate(refusal('INVOICE_DUPLICATE', 409))).toBe(true);
    expect(isInvoiceDuplicate(refusal('VALIDATION_FAILED'))).toBe(false);
    expect(isInvoiceDuplicate(new Error('x'))).toBe(false);
  });
});
