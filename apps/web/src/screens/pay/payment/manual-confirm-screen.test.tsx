import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PaymentDetailScreen from './PaymentDetailScreen';
import { toManualOutcome } from './manual-confirm-model';
import { ACCOUNTANT, actions, client, mount, payment, paymentId, routeOf, world } from './test-support';

const ROUTE = routeOf('PAY-03', 'PAY', 'FR-PAY-03');
const PATH = `/pay/pay-03?request=${paymentId(1)}`;
const EVIDENCE = '00000000-0000-4000-8000-0000000000b1';
const ITEM = '00000000-0000-4000-8000-0000000000e5';
const TRANSACTION = '00000000-0000-4000-8000-0000000000f5';
const RIGHT = [...ACCOUNTANT, 'treasury.confirm_manual'];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fill = (): void => {
  fireEvent.change(document.getElementById('manual-document-no') as HTMLInputElement, { target: { value: 'CT-77' } });
  fireEvent.change(document.getElementById('manual-document-date') as HTMLInputElement, { target: { value: '2026-11-05' } });
  fireEvent.change(document.getElementById('manual-confirmed-at') as HTMLInputElement, { target: { value: '2026-11-05T09:30' } });
  fireEvent.change(document.getElementById('manual-evidence') as HTMLInputElement, { target: { value: EVIDENCE } });
};

function open(command: (operation: string, input: unknown) => unknown, permissions: readonly string[] = RIGHT) {
  const h = client(world({ payments: [payment(1, { status: 'SENT_TREASURY', actions: actions({ revise: false, attach_document: false, cancel: false }) })] }), command);
  mount(<PaymentDetailScreen route={ROUTE} />, h, { permissions, path: PATH });
  return h;
}

describe('the outcome of the manual confirmation (confirmTreasuryManually)', () => {
  it('reads an exception and the reconciliation item from the answer', () => {
    expect(toManualOutcome({ status: 'EXCEPTION', resource_id: TRANSACTION, reconciliation_item_id: ITEM, resource_version: 1 })).toEqual({ status: 'EXCEPTION', transactionId: TRANSACTION, reconciliationItemId: ITEM, exception: true });
    expect(toManualOutcome({ status: 'UNMATCHED', resource_id: TRANSACTION, reconciliation_item_id: null })).toEqual({ status: 'UNMATCHED', transactionId: TRANSACTION, reconciliationItemId: null, exception: false });
    expect(toManualOutcome(undefined).exception).toBe(false);
  });

  it('says reconciliation is required, with a link to the item, when the amount was not the net of the request', async () => {
    open(() => ({ operation_id: 'o', status: 'EXCEPTION', resource_version: 1, resource_id: TRANSACTION, reconciliation_item_id: ITEM }));
    await screen.findByTestId('request-no');
    fireEvent.click(document.querySelector('button[data-action="manual-confirm"]') as HTMLElement);
    await screen.findByRole('dialog');
    fill();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    const alert = await screen.findByTestId('manual-exception');
    expect(alert.querySelector('a')?.getAttribute('href')).toContain(ITEM);
    expect(screen.queryByTestId('manual-done')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the ordinary outcome when the amount matched', async () => {
    const h = open(() => ({ operation_id: 'o', status: 'UNMATCHED', resource_version: 1, resource_id: TRANSACTION, reconciliation_item_id: null }));
    await screen.findByTestId('request-no');
    fireEvent.click(document.querySelector('button[data-action="manual-confirm"]') as HTMLElement);
    await screen.findByRole('dialog');
    fill();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(await screen.findByTestId('manual-done')).toBeTruthy();
    expect(screen.queryByTestId('manual-exception')).toBeNull();
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('confirmTreasuryManually', expect.anything()));
  });

  it('offers the action only to who holds the right', async () => {
    open(() => ({}), ACCOUNTANT);
    await screen.findByTestId('request-no');
    expect(document.querySelector('button[data-action="manual-confirm"]')).toBeNull();
  });
});
