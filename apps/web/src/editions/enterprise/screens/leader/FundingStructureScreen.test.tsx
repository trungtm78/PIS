import { ApiError } from '@machvon/api-client';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../../i18n';
import { harness } from '../../../../screens/sas/test-support';
import { mount } from '../shared/test-support';
import FundingStructureScreen from './FundingStructureScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const ROUTE = { id: 'HOME-07', req: 'FR-HOME-07', title: 'x', path: '/home/home-07', kind: 'table', area: 'insights', module: 'HOME', group: 'g', role: 'workspace', parent: null } as never;
afterEach(() => cleanup());

const cls = (code: string, over: Record<string, unknown> = {}) => ({ class_code: code, plan_vnd: null, disbursed_vnd: null, plan_share_pct: null, disbursed_share_pct: null, rate_pct: null, null_reason: 'NO_DATA', ...over });
const rates = (structure: unknown) => ({
  snapshot_id: 's-1',
  as_of_date: '2026-10-31',
  revision: 1,
  snapshot_hash: 'h',
  prior_snapshot_id: null,
  prior_as_of_date: null,
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  formula: 'f',
  company: {},
  units: [],
  projects: [],
  structure,
  as_of: '2026-11-10T01:00:00.000Z',
});
const STRUCTURE = {
  measure: 'DISBURSED',
  plan_total_vnd: '1200000000000',
  disbursed_total_vnd: '550000000000',
  classes: [
    cls('EQUITY', { plan_vnd: '800000000000', disbursed_vnd: '450000000000', plan_share_pct: '66.6667', disbursed_share_pct: '81.8182', rate_pct: '56.2500', null_reason: null }),
    cls('LOAN', { plan_vnd: '400000000000', disbursed_vnd: '100000000000', plan_share_pct: '33.3333', disbursed_share_pct: '18.1818', rate_pct: '25.0000', null_reason: null }),
    cls('OTHER'),
  ],
};

function open(answer: unknown) {
  const h = harness((operation) => (operation === 'getLeaderRates' ? answer : new Error(`unexpected read ${operation}`)));
  mount(<FundingStructureScreen route={ROUTE} />, h, { permissions: ['home.read'] });
  return h;
}

describe('HOME-07 of the enterprise edition: the funding structure by equity, loan and other', () => {
  it('shows each class of the enterprise taxonomy with its plan, its share and its rate, with thousands separators, and no public source', async () => {
    open(rates(STRUCTURE));
    const equity = await screen.findByTestId('structure-EQUITY');
    expect(within(equity).getByText(word('ent.funding.class.equity'))).toBeTruthy();
    expect(equity.textContent).toContain(word('home.funding.card.amount', { value: '800' }));
    expect(equity.textContent).toContain(word('home.funding.card.exact', { value: '800.000.000.000' }));
    expect(screen.getByTestId('structure-EQUITY-plan-share').textContent).toBe(word('ent.funding.card.planShare', { value: '66,67%' }));
    expect(screen.getByTestId('structure-EQUITY-disbursed').textContent).toBe(word('ent.funding.card.disbursed', { value: word('home.funding.card.amount', { value: '450' }) }));
    expect(screen.getByTestId('structure-LOAN').textContent).toContain(word('home.funding.card.amount', { value: '400' }));
    expect(screen.getByTestId('funding-total-plan').textContent).toContain(word('home.funding.card.amount', { value: '1.200' }));
    const text = screen.getByTestId('funding-structure').textContent ?? '';
    for (const publicWord of ['NSTW', 'NSDP', 'ODA', 'CTMTQG', 'Thủ tướng']) expect(text).not.toContain(publicWord);
  });

  it('says a class nobody has a figure for ("no data"), never 0', async () => {
    open(rates(STRUCTURE));
    const other = await screen.findByTestId('structure-OTHER');
    expect(other.textContent).toContain(word('home.funding.card.none'));
    expect(other.textContent).not.toMatch(/\b0 tỷ/);
    expect(screen.getByTestId('structure-OTHER-plan-share').textContent).toBe(word('ent.funding.card.planShare', { value: word('ent.leader.noData.text') }));
  });

  it('says there is no frozen snapshot yet (404) as a state, with no retry button', async () => {
    open(failure(404, 'RESOURCE_NOT_FOUND'));
    expect((await screen.findByTestId('funding-structure-empty')).textContent).toBe(word('ent.funding.empty'));
    expect(screen.queryByTestId('funding-structure-error')).toBeNull();
  });

  it('keeps a retry for any other failure', async () => {
    open(failure(500, 'INTERNAL'));
    const alert = await screen.findByTestId('funding-structure-error');
    expect(within(alert).getByRole('button', { name: word('ent.leader.retry.action') })).toBeTruthy();
  });
});
