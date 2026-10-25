import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, advance, advanceId, client, contractId, mount, plan, routeOf, world } from '../../pay/advance/test-support';
import type { World } from '../../pay/advance/test-support';
import ScheduleScreen from './ScheduleScreen';

const ROUTE = routeOf('CTR-06', 'CTR', 'FR-CTR-06');
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, path = `/ctr/ctr-06?contract=${contractId(1)}`) {
  const h = client(state);
  mount(<ScheduleScreen route={ROUTE} />, h, { permissions: READER, path });
  return h;
}

const rowOf = (id: string): HTMLElement => document.querySelector(`tr[data-advance="${id}"]`) as HTMLElement;

describe('ScheduleScreen (CTR-06): the advances of a contract and the schedule of their recovery', () => {
  it('asks for a contract when the address names none', async () => {
    open(world(), '/ctr/ctr-06');
    expect((await screen.findByTestId('no-contract')).textContent).toBe(vi_['ctr.advance.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.advance.title']);
    expect(screen.getByText(text('ctr.advance.footer', { id: 'CTR-06', req: 'FR-CTR-06' }))).toBeTruthy();
  });

  it('UI-CTR-06: shows each advance with its value, what has come back, the deadline, the cap of the category and the member of the joint venture', async () => {
    open(world());
    await screen.findByTestId('advances');
    const first = rowOf(advanceId(1));
    expect(within(first).getByTestId('amount').textContent).toBe('2.000.000.000');
    expect(within(first).getByTestId('recovered').textContent).toBe('750.000.000');
    expect(within(first).getByTestId('outstanding').textContent).toBe('1.250.000.000');
    expect(within(first).getByTestId('deadline').textContent).toBe('2026-07-31');
    expect(within(first).getByTestId('cap').textContent).toBe(text('ctr.advance.cap', { pct: '20', amount: '2.000.000.000' }));
    expect(within(first).getByTestId('member').textContent).toBe('Nhà thầu A · LEAD');
    expect(within(first).getByTestId('status').textContent).toBe(vi_['pay.advance.status.recovering']);
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(rowOf(advanceId(2)).getAttribute('aria-current')).toBeNull();
    // The rule that capped them waits for its confirmation, and the screen says so.
    expect(screen.getByTestId('awaiting').textContent).toBe(text('ctr.advance.awaiting', { cxn: 'CXN-02' }));
  });

  it('AC-ST-PAY-004-3: shows the schedule of the advance in view: the threshold, what the member asked to be paid, what should have come back, and the milestones', async () => {
    open(world());
    await screen.findByTestId('milestones');
    expect(screen.getByTestId('threshold').textContent).toBe(text('ctr.advance.fact.thresholdValue', { pct: '80', amount: '4.800.000.000' }));
    expect(screen.getByTestId('work').textContent).toBe('6.000.000.000');
    expect(screen.getByTestId('gross').textContent).toBe('2.400.000.000');
    expect(screen.getByTestId('remaining').textContent).toBe('2.400.000.000');
    expect(screen.getByTestId('target').textContent).toBe('1.000.000.000');
    expect(screen.getByTestId('behind').textContent).toBe('250.000.000');
    expect((screen.getByTestId('share') as HTMLProgressElement).value).toBe(37);
    const rows = within(screen.getByTestId('milestones')).getAllByRole('row').slice(1);
    expect(rows.map((row) => [within(row).getAllByRole('cell')[0]?.textContent, within(row).getByTestId('milestone-gross').textContent, within(row).getByTestId('milestone-recovered').textContent])).toEqual([
      ['25%', '1.200.000.000', '500.000.000'],
      ['50%', '2.400.000.000', '1.000.000.000'],
      ['75%', '3.600.000.000', '1.500.000.000'],
      ['100%', '4.800.000.000', '2.000.000.000'],
    ]);
  });

  it('shows the advance that is named in the address, and says when its schedule is not there', async () => {
    const second = advance(2, { status: 'PLANNED', kind: 'CONTRACT', cap_pct: null, cap_rule_awaiting_confirmation: false, paid_vnd: '0', recovered_vnd: '0', outstanding_vnd: '0' });
    const h = open(world({ advances: [advance(1), second], plans: new Map([[advanceId(1), plan(1)]]) }), `/ctr/ctr-06?contract=${contractId(1)}&advance=${advanceId(2)}`);
    await screen.findByTestId('advances');
    expect(rowOf(advanceId(2)).getAttribute('aria-current')).toBe('true');
    expect(within(rowOf(advanceId(2))).getByTestId('cap').textContent).toBe('2.000.000.000');
    await waitFor(() => expect(screen.getByTestId('no-plan').textContent).toBe(vi_['ctr.advance.noPlan']));
    expect(h.read).toHaveBeenCalledWith('getAdvanceRecoveryPlan', { path: { id: advanceId(2) } });
    expect(screen.queryByTestId('milestones')).toBeNull();
  });

  it('says so when the contract has no advance, and shows no warning when no rule waits for its confirmation', async () => {
    open(world({ advances: [] }));
    expect((await screen.findByTestId('no-advances')).textContent).toBe(vi_['ctr.advance.empty']);
    expect(screen.queryByTestId('awaiting')).toBeNull();
    expect(screen.queryByText(vi_['ctr.advance.schedule'])).toBeNull();
    cleanup();
    open(world({ advances: [advance(1, { cap_rule_awaiting_confirmation: false })] }));
    await screen.findByTestId('advances');
    expect(screen.queryByTestId('awaiting')).toBeNull();
  });

  it('shows the state of a failed read, and never half a schedule', async () => {
    open(world({ failing: new Set(['listAdvances']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.queryByTestId('advances')).toBeNull();
  });
});
