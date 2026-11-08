import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { client, line, mount, routeOf, world, word } from '../test-support';
import type { Harness } from '../test-support';
import RiskSignalBoardScreen from './RiskSignalBoardScreen';
import { toRiskAlertRegister } from './alert-register';

afterEach(cleanup);

const ROUTE = routeOf('PRJ-28', 'FR-PRJ-28');
const PROJECT = line(1).id;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const policy = { name: 'RISK_SIGNAL_POLICY', code: 'DEFAULT', formula: 'Likelihood times impact', source: 'Governance rule registry', as_of: '2026-11-08', legal_status: 'UNVERIFIED', unverified: true, version: 'built-in:1', owner: 'PRJ', params: { impact: {}, thresholds: {}, open_from_likelihood: 2, critical_score: 15, jump_points: 6 } };
const board = { items: [], next_cursor: null, counts: { total: 0, critical: 0, medium: 0, low: 0, open_alerts: 0 }, policy, as_of: '2026-11-08' };
const riskAlert = (n: number, over: Record<string, unknown> = {}) => ({ id: uuid(n), project_id: PROJECT, project_code: 'DA-2026-001', alert_type: 'RISK_SCORE_CRITICAL', subject_kind: 'SIGNAL', subject_id: uuid(400), signal_kind: 'SCHEDULE_DELAY', score: 16, prior_score: 12, threshold: 15, rule_version: 'built-in:1', rule_unverified: true, status: 'OPEN', raised_on: '2026-11-07', acknowledged_at: null, acknowledge_note: null, resolved_on: null, version: 1, ...over });

function open(register: (input: unknown) => unknown): Harness {
  const h = client(world(), () => ({}));
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation === 'getRiskSignalBoard') return Promise.resolve(board);
    if (operation === 'listProjectRiskAlerts') {
      const value = register(input);
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    return Promise.reject(new Error(`unexpected read ${operation}`));
  });
  mount(<RiskSignalBoardScreen route={ROUTE} />, h, { permissions: ['project.read'], path: '/prj/prj-28' });
  return h;
}

describe('PRJ-28 the register of risk alerts (listProjectRiskAlerts)', () => {
  it('lists the alerts across projects with the project to open, the score against the line and the "i"', async () => {
    const h = open(() => ({ items: [riskAlert(1), riskAlert(2, { alert_type: 'RISK_SCORE_JUMP', status: 'RESOLVED', resolved_on: '2026-11-08', rule_unverified: false })], as_of: '2026-11-08' }));
    const link = await screen.findByTestId(`risk-alert-open-${uuid(1)}`);
    expect(link.getAttribute('href')).toContain(`?id=${PROJECT}`);
    expect(h.read).toHaveBeenCalledWith('listProjectRiskAlerts', { query: { limit: 100 } });
    const table = screen.getByRole('table', { name: word('lookahead.prj.riskAlerts.title') });
    expect(within(table).getAllByRole('button', { name: new RegExp(word('mr1.info.open').split('{')[0] ?? '') }).length).toBe(2);
    expect(within(table).getByText(word('mr1.risk.alert.status.resolved'))).toBeTruthy();
    expect(screen.queryByTestId('risk-alert-cut')).toBeNull();
  });

  it('reads again with the chosen status and says an empty register is empty', async () => {
    const h = open((input) => ((input as { query: { status?: string } }).query.status === 'ACKNOWLEDGED' ? { items: [], as_of: '2026-11-08' } : { items: [riskAlert(1)], as_of: '2026-11-08' }));
    await screen.findByTestId(`risk-alert-open-${uuid(1)}`);
    fireEvent.change(screen.getByTestId('risk-alert-filter'), { target: { value: 'ACKNOWLEDGED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listProjectRiskAlerts', { query: { limit: 100, status: 'ACKNOWLEDGED' } }));
    await waitFor(() => expect(screen.queryByTestId(`risk-alert-open-${uuid(1)}`)).toBeNull());
  });

  it('says the list is cut, and shows a failed read as an error with a retry', async () => {
    open(() => ({ items: Array.from({ length: 100 }, (_, index) => riskAlert(index + 1)), as_of: '2026-11-08' }));
    expect(await screen.findByTestId('risk-alert-cut')).toBeTruthy();
    cleanup();
    let calls = 0;
    open(() => (calls++ === 0 ? new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }) : { items: [riskAlert(1)], as_of: '2026-11-08' }));
    const retry = await screen.findByRole('button', { name: /thử lại|try again|retry/i });
    fireEvent.click(retry);
    expect(await screen.findByTestId(`risk-alert-open-${uuid(1)}`)).toBeTruthy();
  });
});

describe('toRiskAlertRegister', () => {
  it('drops rows without an id or project, reads an unknown status as open and an unmarked rule as not confirmed', () => {
    const parsed = toRiskAlertRegister({ items: [{ id: 'a' }, riskAlert(1, { status: 'WEIRD', rule_unverified: undefined })], as_of: '2026-11-08' });
    expect(parsed?.items.map((row) => [row.id, row.status, row.ruleUnverified])).toEqual([[uuid(1), 'OPEN', true]]);
    expect(toRiskAlertRegister(null)).toBeUndefined();
  });
});
