import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import parts_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import SodAuditScreen from './SodAuditScreen';

const catalogue = { ...(vi_ as Record<string, string>), ...(parts_ as Record<string, string>) };
const word = (key: string): string => catalogue[key] ?? key;
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0241'}${String(n).padStart(8, '0')}`;
const ROUTE = routeOf('AUD-13', 'FR-AUD-13');

const use = (n: number, outcome: string, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  outcome,
  exception_id: outcome === 'EXCEPTION_USED' ? uuid(900) : null,
  action_a: 'acceptance.approve',
  action_b: 'payment.verify',
  scope: 'SAME_CONTRACT',
  subject_id: uuid(800),
  member_id: uuid(600),
  member_name: `Người ${n}`,
  taking: 'payment.verify',
  command: 'verifyPaymentRequest',
  record_id: uuid(700 + n),
  rule_version: 0,
  used_at: '2026-11-08T03:00:00.000Z',
  ...extra,
});

const exception = (n: number, status: string, uses: number) => ({
  id: uuid(n),
  action_a: 'acceptance.approve',
  action_b: 'payment.verify',
  scope: 'SAME_CONTRACT',
  subject_id: uuid(800),
  member_id: uuid(600),
  member_name: 'Người được áp dụng',
  requested_by: uuid(601),
  requested_by_name: 'Người xin',
  reason: 'Kiểm soát viên duy nhất nghỉ phép',
  valid_from: '2026-11-01',
  valid_to: '2026-11-10',
  rule_version: 0,
  approvers_needed: 2,
  approvals: 2,
  status,
  revoke_reason: null,
  uses,
  version: 3,
});

function open(world: { uses: Array<Record<string, unknown>> | Error; exceptions: Array<Record<string, unknown>> } = { uses: [], exceptions: [] }, permissions: readonly string[] = ['aud.sod.read']) {
  const h = baseHarness(() => new Error('unexpected read'));
  const readAll = vi.fn((operation: string, input?: { query?: Record<string, string> }) => {
    if (operation === 'listSodAuditUses') {
      if (world.uses instanceof Error) return Promise.reject(world.uses);
      const outcome = input?.query?.outcome;
      return Promise.resolve(world.uses.filter((row) => outcome === undefined || row.outcome === outcome));
    }
    if (operation === 'listSodAuditExceptions') return Promise.resolve(world.exceptions);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  (h.client as unknown as { readAll: unknown }).readAll = readAll;
  mountInSession(<SodAuditScreen route={ROUTE} />, h, { permissions }, '/aud/aud-13');
  return { ...h, readAll };
}

afterEach(() => cleanup());

describe('SodAuditScreen (AUD-13): what the auditor reads of the separation of duties', () => {
  it('UI-AUD-13: lists the commands that met a conflict with the duty taken, the pair, the command and what came of it, and filters by outcome', async () => {
    const h = open({ uses: [use(1, 'EXCEPTION_USED'), use(2, 'WARNED'), use(3, 'BLOCKED')], exceptions: [] });
    await screen.findByTestId('uses');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('govd.sodaudit.title'));
    const row = (n: number) => document.querySelector(`[data-use="${uuid(n)}"]`) as HTMLElement;
    await waitFor(() => expect(row(1)).not.toBeNull());
    expect(within(row(1)).getByTestId('outcome').textContent).toBe(word('govd.sod.outcome.used'));
    expect(within(row(2)).getByTestId('outcome').textContent).toBe(word('govd.sod.outcome.warned'));
    expect(within(row(3)).getByTestId('outcome').textContent).toBe(word('govd.sod.outcome.blocked'));
    expect(row(3).textContent).toContain(word('govd.sod.action.acceptanceApprove'));
    expect(row(3).textContent).toContain(word('govd.sod.action.paymentVerify'));
    expect(row(3).textContent).toContain('verifyPaymentRequest');
    expect(row(3).textContent).toContain('Người 3');
    fireEvent.change(document.querySelector('[data-filter="outcome"]') as HTMLElement, { target: { value: 'BLOCKED' } });
    await waitFor(() => expect(h.readAll).toHaveBeenCalledWith('listSodAuditUses', { query: { outcome: 'BLOCKED' } }));
    await waitFor(() => expect(document.querySelector(`[data-use="${uuid(1)}"]`)).toBeNull());
    expect(document.querySelector(`[data-use="${uuid(3)}"]`)).not.toBeNull();
  });

  it('lists the exceptions with who asked, who is covered, the approvals and how often each was used, and has nothing to press', async () => {
    open({ uses: [], exceptions: [exception(1, 'APPROVED', 4), exception(2, 'EXPIRED', 0)] });
    await waitFor(() => expect(document.querySelector('[data-tab="exceptions"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-tab="exceptions"]') as HTMLElement);
    await screen.findByTestId('exceptions');
    const row = (n: number) => document.querySelector(`[data-exception="${uuid(n)}"]`) as HTMLElement;
    await waitFor(() => expect(row(1)).not.toBeNull());
    expect(within(row(1)).getByTestId('uses').textContent).toBe('4');
    expect(within(row(1)).getByTestId('approvals').textContent).toBe('2/2 người');
    expect(within(row(2)).getByTestId('status').textContent).toBe(word('govd.sod.status.expired'));
    expect(row(1).textContent).toContain('Người xin');
    expect(row(1).textContent).toContain('Người được áp dụng');
    expect(document.querySelectorAll('[data-action]').length).toBe(0);
  });

  it('says why when there is nothing to show: empty, error, and denied without the audit grant (nothing is read)', async () => {
    open({ uses: [], exceptions: [] });
    await waitFor(() => expect(screen.getByText(word('states.empty.title'))).toBeTruthy());
    cleanup();
    open({ uses: new Error('down'), exceptions: [] });
    await waitFor(() => expect(screen.getByText(word('states.error.title'))).toBeTruthy());
    cleanup();
    const denied = open({ uses: [], exceptions: [] }, ['adm.sod.read']);
    await waitFor(() => expect(screen.getByText(word('states.denied.title'))).toBeTruthy());
    expect(denied.readAll).not.toHaveBeenCalled();
  });
});
