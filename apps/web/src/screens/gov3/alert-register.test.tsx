import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import type { WebRoute } from '../../routes/types';
import { harness, mount } from '../sas/test-support';
import BaselineScreen from './BaselineScreen';
import { toAlertRegister } from './alert-register';

const word = (key: string): string => {
  const found = (vi_ as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const route: WebRoute = { id: 'PRJ-26', path: '/prj/prj-26', title: 'PRJ-26', kind: 'board', area: 'investment', module: 'PRJ', group: 'g', role: 'workspace', parent: null, req: 'FR-PRJ-26' };
const alert = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid(n), project_id: uuid(100 + n), project_code: `DA-0${n}`, alert_type: 'RESCHEDULE_COUNT', audience: 'AUD', subject_kind: 'MILESTONE', subject_id: uuid(200 + n), subject_code: 'M-1', move_count: 3, threshold: 3, rule_version: '1', status: 'OPEN', raised_by: uuid(300), raised_at: '2026-11-05T03:00:00.000Z', acknowledged_by: null, acknowledged_at: null, acknowledge_note: null, version: 1, ...over });
const open = (answer: (input: unknown) => unknown) => {
  const h = harness((operation, input) => (operation === 'listGovernanceAlerts' ? answer(input) : new Error(`unexpected ${operation}`)));
  mount(<BaselineScreen route={route} />, h, ['project.governance.alert.read'], '/prj/prj-26');
  return h;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PRJ-26 the register of governance alerts (listGovernanceAlerts)', () => {
  it('lists the alerts of the scope with the project to open and the moves with their "i"', async () => {
    const h = open(() => ({ items: [alert(1), alert(2, { status: 'ACKNOWLEDGED', acknowledged_at: '2026-11-06T03:00:00.000Z' })], as_of: '2026-11-08' }));
    const link = await screen.findByTestId(`gov-alert-open-${uuid(1)}`);
    expect(link.getAttribute('href')).toBe(`/prj/prj-26?project=${uuid(101)}`);
    expect(h.read).toHaveBeenCalledWith('listGovernanceAlerts', { query: { limit: 100 } });
    const table = screen.getByRole('table', { name: word('lookahead.prj.govAlerts.title') });
    expect(within(table).getAllByRole('button', { name: new RegExp(word('govc.bi.info.open').split('{')[0] ?? '') }).length).toBe(2);
    expect(within(table).getByText(word('govb1.alerts.status.acknowledged'))).toBeTruthy();
    expect(screen.queryByTestId('gov-alert-cut')).toBeNull();
  });

  it('reads again with the status the person chose, and says an empty register is empty', async () => {
    const h = open((input) => ((input as { query: { status?: string } }).query.status === 'OPEN' ? { items: [], as_of: '2026-11-08' } : { items: [alert(1)], as_of: '2026-11-08' }));
    await screen.findByTestId(`gov-alert-open-${uuid(1)}`);
    fireEvent.change(screen.getByTestId('gov-alert-filter'), { target: { value: 'OPEN' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listGovernanceAlerts', { query: { limit: 100, status: 'OPEN' } }));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    expect(screen.queryByTestId(`gov-alert-open-${uuid(1)}`)).toBeNull();
  });

  it('says when the list is cut at the limit of the read', async () => {
    open(() => ({ items: Array.from({ length: 100 }, (_, index) => alert(index + 1)), as_of: '2026-11-08' }));
    expect(await screen.findByTestId('gov-alert-cut')).toBeTruthy();
  });

  it('shows a failed read as an error with a retry, not as an empty register', async () => {
    let calls = 0;
    open(() => (calls++ === 0 ? new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) : { items: [alert(1)], as_of: '2026-11-08' }));
    const retry = await screen.findByRole('button', { name: /thử lại|try again|retry/i });
    expect(screen.queryByText(word('states.empty.title'))).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByTestId(`gov-alert-open-${uuid(1)}`)).toBeTruthy();
  });
});

describe('toAlertRegister', () => {
  it('drops rows without an id or project and reads an unknown status as open', () => {
    expect(toAlertRegister({ items: [{ id: 'a' }, alert(1, { status: 'WEIRD' })], as_of: '2026-11-08' })?.items.map((row) => [row.id, row.status])).toEqual([[uuid(1), 'OPEN']]);
    expect(toAlertRegister({ nope: true })).toBeUndefined();
  });
});
