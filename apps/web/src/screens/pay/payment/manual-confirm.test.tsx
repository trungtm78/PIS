import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, mount } from '../test-support';
import { ManualConfirmDialog } from './ManualConfirmDialog';
import { MANUAL_CONFIRM_PERMISSION, confirmedInstant, describeManualRefusal, emptyManualConfirm, manualConfirmBody, validateManualConfirm } from './manual-confirm-model';
import type { PaymentRequest } from './model';

const REQUEST = '00000000-0000-4000-8000-0000000000a1';
const EVIDENCE = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-11-08T03:00:00.000Z');
const request = { id: REQUEST, requestNo: 'YC-1', netVnd: '1.000.000', status: 'SENT_TREASURY', version: 3 } as unknown as PaymentRequest;
const sound = { documentNo: 'CT-77', documentDate: '2026-11-05', amountVnd: '1000000', confirmedAt: '2026-11-05T09:30', evidenceVersionId: EVIDENCE };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

describe('the model of the manual confirmation', () => {
  it('accepts a sound form', () => {
    expect(validateManualConfirm(sound, NOW)).toEqual({});
    expect(MANUAL_CONFIRM_PERMISSION).toBe('treasury.confirm_manual');
  });

  it('wants every field, whole dong, real days that are not in the future, and the id of a document version', () => {
    expect(Object.keys(validateManualConfirm(emptyManualConfirm(''), NOW)).sort()).toEqual(['amountVnd', 'confirmedAt', 'documentDate', 'documentNo', 'evidenceVersionId']);
    expect(validateManualConfirm({ ...sound, amountVnd: '12.5' }, NOW).amountVnd).toBe('amount');
    expect(validateManualConfirm({ ...sound, amountVnd: '-1' }, NOW).amountVnd).toBe('amount');
    expect(validateManualConfirm({ ...sound, documentDate: '2026-02-30' }, NOW).documentDate).toBe('day');
    expect(validateManualConfirm({ ...sound, documentDate: '2026-11-09' }, NOW).documentDate).toBe('future');
    expect(validateManualConfirm({ ...sound, confirmedAt: 'tomorrow' }, NOW).confirmedAt).toBe('instant');
    expect(validateManualConfirm({ ...sound, confirmedAt: '2027-01-01T00:00' }, NOW).confirmedAt).toBe('future');
    expect(validateManualConfirm({ ...sound, evidenceVersionId: 'nope' }, NOW).evidenceVersionId).toBe('uuid');
    expect(validateManualConfirm({ ...sound, documentNo: 'x'.repeat(2001) }, NOW).documentNo).toBe('long');
    expect(confirmedInstant('nope')).toBeUndefined();
  });

  it('builds the body with the request, the trimmed number and an instant', () => {
    const body = manualConfirmBody(REQUEST, { ...sound, documentNo: ' CT-77 ', evidenceVersionId: ` ${EVIDENCE.toUpperCase()} ` });
    expect(body).toMatchObject({ payment_request_id: REQUEST, document_no: 'CT-77', document_date: '2026-11-05', amount_vnd: '1000000', evidence_document_version_id: EVIDENCE });
    expect(body.confirmed_at).toMatch(/^2026-11-05T/);
  });

  it('tells the duplicate and the mismatch apart from the other refusals', () => {
    expect(describeManualRefusal(problem(409, 'TREASURY_TRANSACTION_DUPLICATE'))).toBe('duplicate');
    expect(describeManualRefusal(problem(409, 'AMOUNT_MISMATCH_OPENED'))).toBe('mismatch');
    expect(describeManualRefusal(problem(403, 'SELF_APPROVAL_DENIED'))).toEqual({ general: 'selfApproval' });
    expect(describeManualRefusal(new Error('x'))).toEqual({ general: 'general' });
  });
});

describe('the manual confirmation dialog (confirmTreasuryManually)', () => {
  const fill = (): void => {
    fireEvent.change(document.getElementById('manual-document-no') as HTMLInputElement, { target: { value: 'CT-77' } });
    fireEvent.change(document.getElementById('manual-document-date') as HTMLInputElement, { target: { value: '2026-11-05' } });
    fireEvent.change(document.getElementById('manual-confirmed-at') as HTMLInputElement, { target: { value: '2026-11-05T09:30' } });
    fireEvent.change(document.getElementById('manual-evidence') as HTMLInputElement, { target: { value: EVIDENCE } });
  };

  it('starts with the net amount of the request and sends the confirmation once', async () => {
    const h = harness(() => ({}), () => ({ operation_id: 'o', status: 'SETTLED', resource_version: 4, resource_id: REQUEST }));
    const onDone = vi.fn();
    mount(<ManualConfirmDialog request={request} onDone={onDone} onClose={() => undefined} />, h, [MANUAL_CONFIRM_PERMISSION]);
    expect((document.getElementById('manual-amount') as HTMLInputElement).value).toBe('1000000');
    fill();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('confirmTreasuryManually', expect.objectContaining({ body: expect.objectContaining({ payment_request_id: REQUEST, document_no: 'CT-77', amount_vnd: '1000000', evidence_document_version_id: EVIDENCE }) }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('sends nothing while a field is wrong, and says which', async () => {
    const h = harness(() => ({}));
    mount(<ManualConfirmDialog request={request} onDone={() => undefined} onClose={() => undefined} />, h, [MANUAL_CONFIRM_PERMISSION]);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(2);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says a refusal of the maker-checker rule and keeps the dialog open with what was typed', async () => {
    const h = harness(() => ({}), () => problem(403, 'SELF_APPROVAL_DENIED'));
    mount(<ManualConfirmDialog request={request} onDone={() => undefined} onClose={() => undefined} />, h, [MANUAL_CONFIRM_PERMISSION]);
    fill();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(await screen.findByTestId('refusal')).toBeTruthy();
    expect((document.getElementById('manual-document-no') as HTMLInputElement).value).toBe('CT-77');
  });

  it('says a duplicate and a mismatch in the words of the dialog', async () => {
    for (const code of ['TREASURY_TRANSACTION_DUPLICATE', 'AMOUNT_MISMATCH_OPENED']) {
      const h = harness(() => ({}), () => problem(409, code));
      mount(<ManualConfirmDialog request={request} onDone={() => undefined} onClose={() => undefined} />, h, [MANUAL_CONFIRM_PERMISSION]);
      fill();
      fireEvent.submit(document.querySelector('form') as HTMLFormElement);
      expect((await screen.findByTestId('refusal')).textContent).not.toBe('');
      cleanup();
    }
  });
});
