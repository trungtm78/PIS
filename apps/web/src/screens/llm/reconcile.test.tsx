import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, mount } from '../sas/test-support';
import { ReconcilePanel } from './ReconcilePanel';
import { EMPTY_RECONCILE, RECONCILE_PERMISSION, mayReconcile, reconcileBody, reconcileProblems, toggleReservation } from './reconcile-model';
import type { BudgetEntry, ReservationEntry } from './llm-model';

const BUDGET = '00000000-0000-4000-8000-0000000000a1';
const R1 = '00000000-0000-4000-8000-0000000000b1';
const R2 = '00000000-0000-4000-8000-0000000000b2';
const budget = { id: BUDGET, version: 6 } as unknown as BudgetEntry;
const waiting = [
  { id: R1, requestId: '11111111-aaaa', amount: '50000', status: 'PENDING_RECONCILE' },
  { id: R2, requestId: '22222222-bbbb', amount: '70000', status: 'PENDING_RECONCILE' },
] as unknown as ReservationEntry[];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the model of the reconciliation', () => {
  it('wants a reservation and a reason of five characters', () => {
    expect(reconcileProblems(EMPTY_RECONCILE)).toEqual({ reservations: 'noReservation', reason: 'reasonShort' });
    expect(reconcileProblems({ decision: 'reject', reason: 'x'.repeat(2001), reservationIds: [R1] })).toEqual({ reason: 'reasonLong' });
    expect(reconcileProblems({ decision: 'approve', reason: 'The usage was measured', reservationIds: [R1] })).toEqual({});
  });

  it('builds the body, toggles reservations in the order chosen, and offers the decision only to who holds the right', () => {
    expect(reconcileBody({ decision: 'return', reason: ' Measure again ', reservationIds: [R2, R1] })).toEqual({ decision: 'return', reason: 'Measure again', evidence_ids: [R2, R1] });
    expect(toggleReservation([R1], R2)).toEqual([R1, R2]);
    expect(toggleReservation([R1, R2], R1)).toEqual([R2]);
    expect(mayReconcile([RECONCILE_PERMISSION], false)).toBe(true);
    expect(mayReconcile(['llm.read'], false)).toBe(false);
    expect(mayReconcile([RECONCILE_PERMISSION], true)).toBe(false);
  });
});

describe('LLM-09 deciding the reconciliation (post_budgets_id_reconcile)', () => {
  const choose = (): void => {
    fireEvent.click(screen.getByTestId(`reserve-${R2}`));
    fireEvent.change(document.getElementById('reconcile-decision') as HTMLSelectElement, { target: { value: 'reject' } });
    fireEvent.change(document.getElementById('reconcile-reason') as HTMLTextAreaElement, { target: { value: ' Usage never came back ' } });
  };

  it('sends the chosen reservations as evidence, under the version of the budget', async () => {
    const h = harness(() => ({}), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 7, resource_id: BUDGET }));
    mount(<ReconcilePanel budget={budget} waiting={waiting} />, h, [RECONCILE_PERMISSION]);
    choose();
    fireEvent.submit(screen.getByTestId('reconcile-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('post_budgets_id_reconcile', expect.objectContaining({ path: { id: BUDGET }, ifMatchVersion: 6, body: { decision: 'reject', reason: 'Usage never came back', evidence_ids: [R2] } })));
    expect(await screen.findByTestId('reconcile-done')).toBeTruthy();
  });

  it('sends nothing without a reservation and a reason, and says what is missing', async () => {
    const h = harness(() => ({}));
    mount(<ReconcilePanel budget={budget} waiting={waiting} />, h, [RECONCILE_PERMISSION]);
    fireEvent.submit(screen.getByTestId('reconcile-form'));
    expect((await screen.findAllByRole('alert')).length).toBe(2);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows a conflict of versions as a refusal and keeps what was chosen', async () => {
    const h = harness(() => ({}), () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    mount(<ReconcilePanel budget={budget} waiting={waiting} />, h, [RECONCILE_PERMISSION]);
    choose();
    fireEvent.submit(screen.getByTestId('reconcile-form'));
    expect(await screen.findByTestId('reconcile-refusal')).toBeTruthy();
    expect((screen.getByTestId(`reserve-${R2}`) as HTMLInputElement).checked).toBe(true);
  });

  it('shows nothing when no reservation waits or the person does not hold the right', () => {
    const h = harness(() => ({}));
    mount(<ReconcilePanel budget={budget} waiting={[]} />, h, [RECONCILE_PERMISSION]);
    expect(screen.queryByTestId('reconcile-form')).toBeNull();
    cleanup();
    mount(<ReconcilePanel budget={budget} waiting={waiting} />, h, ['llm.read']);
    expect(screen.queryByTestId('reconcile-form')).toBeNull();
  });
});
