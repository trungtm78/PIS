import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountInSession } from '../../doc/test-support';
import { harness } from '../../sas/test-support';
import { toException } from './model';
import type { ExceptionView } from './model';
import { SodDetail, toExceptionDetail } from './SodDetail';

afterEach(cleanup);

const ID = '00000000-0000-4000-8000-000000000f01';
const raw = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  action_a: 'acceptance.approve',
  action_b: 'payment.verify',
  scope: 'SAME_CONTRACT',
  subject_id: '00000000-0000-4000-8000-000000000f02',
  member_id: '00000000-0000-4000-8000-000000000f03',
  member_name: 'Member',
  requested_by: '00000000-0000-4000-8000-000000000f04',
  requested_by_name: 'Requester',
  reason: 'The only controller is on leave',
  valid_from: '2026-11-01',
  valid_to: '2026-11-10',
  rule_version: 0,
  approvers_needed: 2,
  approvals: 1,
  status: 'REQUESTED',
  stored_status: 'REQUESTED',
  revoke_reason: null,
  uses: 0,
  version: 2,
  ...extra,
});
const row = toException(raw()) as ExceptionView;
const open = (answer: () => unknown) => {
  const h = harness(answer);
  mountInSession(<SodDetail row={row} onClose={vi.fn()} />, h, { permissions: ['adm.sod.read'] });
  return h;
};

describe('SodDetail (getSodException)', () => {
  it('parses an exception with the decisions of its approvers, and refuses a body that is not an exception', () => {
    const detail = toExceptionDetail({ ...raw(), decisions: [{ approver_id: 'a1', approver_name: 'An', decision: 'APPROVE', comment: 'Fine', decided_at: '2026-11-02T01:00:00Z' }] });
    expect(detail.exception.id).toBe(ID);
    expect(detail.decisions).toEqual([{ approverId: 'a1', approverName: 'An', decision: 'APPROVE', comment: 'Fine', decidedAt: '2026-11-02T01:00:00Z' }]);
    expect(() => toExceptionDetail({ nope: true })).toThrow();
  });

  it('lists who decided what, with the words they gave, under the exception that was asked for', async () => {
    const h = open(() => ({ ...raw(), decisions: [{ approver_id: 'a1', approver_name: 'An', decision: 'APPROVE', comment: 'Fine', decided_at: '2026-11-02T01:00:00Z' }, { approver_id: 'a2', approver_name: '', decision: 'REJECT', comment: null, decided_at: '2026-11-03T01:00:00Z' }] }));
    const table = await screen.findByTestId('sod-decisions');
    expect(h.read).toHaveBeenCalledWith('getSodException', { path: { id: ID } });
    expect(within(table).getByText('An')).toBeTruthy();
    expect(within(table).getByText('Fine')).toBeTruthy();
    expect(within(table).getByText('2026-11-03')).toBeTruthy();
    expect(within(table).getByText('a2')).toBeTruthy();
    expect(screen.getByText('The only controller is on leave')).toBeTruthy();
  });

  it('says nobody decided yet, and shows an error with a retry that reads again', async () => {
    open(() => ({ ...raw(), decisions: [] }));
    expect(await screen.findByTestId('sod-detail-empty')).toBeTruthy();
    cleanup();
    let calls = 0;
    open(() => (calls++ === 0 ? new ApiError({ status: 500, code: 'BOOM', correlationId: 'c' }) : { ...raw(), decisions: [] }));
    const error = await screen.findByTestId('sod-detail-error');
    fireEvent.click(within(error).getByRole('button'));
    expect(await screen.findByTestId('sod-detail-empty')).toBeTruthy();
  });
});
