import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../../i18n';
import { harness } from '../../../../screens/sas/test-support';
import { mount } from '../shared/test-support';
import { LeaderPanel } from './LeaderPanel';
import { deltaText, percentText } from './model';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
afterEach(() => cleanup());

const row = (level: string, code: string | null, over: Record<string, unknown> = {}) => ({
  level,
  id: code === null ? null : `id-${code}`,
  code,
  name: code === null ? null : `Name ${code}`,
  projects: 2,
  plan_vnd: '1500000000',
  disbursed_vnd: '600000000',
  rate_pct: '40.0000',
  null_reason: null,
  last_year: { rate_pct: '30.0000', disbursed_vnd: '450000000', null_reason: null },
  delta_points: '10.0000',
  trend: 'UP',
  ...over,
});
const rates = (over: Record<string, unknown> = {}) => ({
  snapshot_id: 's-1',
  as_of_date: '2026-10-31',
  revision: 2,
  snapshot_hash: 'h',
  prior_snapshot_id: 's-0',
  prior_as_of_date: '2025-10-31',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  formula: 'f',
  company: row('COMPANY', null),
  units: [row('UNIT', 'BAN-1', { rate_pct: '50.0000', delta_points: '-5.0000', trend: 'DOWN' }), row('UNIT', 'BAN-2', { rate_pct: null, null_reason: 'NO_DATA', last_year: { rate_pct: null, disbursed_vnd: null, null_reason: 'NOT_IN_PRIOR_SNAPSHOT' }, delta_points: null, trend: null })],
  projects: [row('PROJECT', 'DA-1')],
  as_of: '2026-11-09T01:00:00.000Z',
  ...over,
});
const blocked = (over: Record<string, unknown> = {}) => ({
  as_of_date: '2026-11-09',
  total: 2,
  by_source: { PERMIT: 1, ISSUE: 1, LAND: 0, PROCUREMENT: 0 },
  truncated: false,
  projects: [{ project_id: 'p1', project_code: 'DA-01', project_name: 'Duong 205', unit_id: null, unit_name: null, sources: ['PERMIT', 'ISSUE'], items: 2, since: '2026-10-01', days: 39 }],
  as_of: '2026-11-09T01:00:00.000Z',
  ...over,
});
const widget = { counts: { overdue: 3, due_soon: 1, escalated: 0, open: 4 }, items: [], truncated: false, definitions: {}, policy: { code: 'DEFAULT', version: null, source: 'DEFAULT', unverified: true, reminder_days_before: [], escalate_after_overdue_days: 7, max_extensions: 1, max_extension_days: 7, close_requires_evidence: true }, as_of: '2026-11-09T01:00:00.000Z' };

function open(part: 'rates' | 'summary' | 'tiles' | 'all', answers: Record<string, unknown> = {}) {
  const h = harness((operation) => (operation in answers ? answers[operation] : operation === 'getLeaderRates' ? rates() : operation === 'getBlockedProjects' ? blocked() : widget));
  mount(<LeaderPanel part={part} />, h, { permissions: ['home.read'] });
  return h;
}

describe('the leader panel of the enterprise edition (ENT-4d)', () => {
  it('shows the company rate against last year, then the units and projects, with a rate that is missing said and not 0', async () => {
    open('rates');
    const panel = await screen.findByTestId('leader-rates');
    expect(within(panel).getAllByText(percentText('40.0000', 'vi')).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(percentText('30.0000', 'vi')).length).toBeGreaterThan(0);
    expect(panel.textContent).toContain(deltaText('10.0000', 'vi'));
    expect(panel.textContent).toContain(deltaText('-5.0000', 'vi'));
    expect(screen.getByTestId('leader-rates-context').textContent).toContain('31/10/2026');
    expect(panel.textContent).toContain('31/10/2025');
    expect(panel.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const units = within(panel).getByRole('table', { name: word('ent.leader.units.caption') });
    const missing = within(units).getByText(/BAN-2/).closest('tr') as HTMLElement;
    expect(missing.textContent).toContain(word('ent.leader.noData.text'));
    expect(missing.textContent).toContain(word('ent.leader.lastYear.new'));
    expect(missing.textContent).not.toMatch(/\b0,00%/);
  });

  it('says there is no snapshot of last year, and draws only the part asked for', async () => {
    open('rates', { getLeaderRates: rates({ prior_snapshot_id: null, prior_as_of_date: null, company: row('COMPANY', null, { last_year: { rate_pct: null, disbursed_vnd: null, null_reason: 'NO_PRIOR_SNAPSHOT' }, delta_points: null, trend: null }) }) });
    const panel = await screen.findByTestId('leader-rates');
    expect(panel.textContent).toContain(word('ent.leader.lastYear.none'));
    expect(screen.queryByTestId('leader-blocked')).toBeNull();
  });

  it('says nothing is frozen when the server has no snapshot, and offers a retry for any other failure', async () => {
    // The server answers 200 with snapshot null and the reason (no failed request); a 404 of an older server says the same.
    open('rates', { getLeaderRates: { snapshot: null, reason: 'NO_FROZEN_SNAPSHOT', as_of: '2026-11-09T01:00:00.000Z' } });
    expect(await screen.findByTestId('leader-rates-empty')).toBeTruthy();
    expect(screen.queryByTestId('leader-rates-error')).toBeNull();
    cleanup();
    open('rates', { getLeaderRates: failure(404, 'RESOURCE_NOT_FOUND') });
    expect(await screen.findByTestId('leader-rates-empty')).toBeTruthy();
    cleanup();
    open('rates', { getLeaderRates: failure(500, 'INTERNAL') });
    expect(await screen.findByTestId('leader-rates-error')).toBeTruthy();
    expect(screen.getByRole('button', { name: word('ent.leader.retry.action') })).toBeTruthy();
  });

  it('shows the projects blocked on procedure by source with how long, and the overdue directives of the DIR widget', async () => {
    open('tiles');
    const tile = await screen.findByTestId('leader-blocked');
    expect(tile.textContent).toContain('DA-01');
    expect(tile.textContent).toContain(word('ent.leader.source.permit'));
    expect(tile.textContent).toContain(word('ent.leader.blocked.days', { days: 39 }));
    expect(screen.queryByTestId('leader-rates')).toBeNull();
    await waitFor(() => expect(screen.getByText(word('dir.widget.title'))).toBeTruthy());
  });

  it('says that none is blocked, and that a list was cut', async () => {
    open('tiles', { getBlockedProjects: blocked({ total: 0, projects: [], by_source: {} }) });
    expect(await screen.findByText(word('ent.leader.blocked.none'))).toBeTruthy();
    cleanup();
    open('tiles', { getBlockedProjects: blocked({ truncated: true }) });
    expect(await screen.findByText(word('ent.leader.blocked.truncated'))).toBeTruthy();
  });
});

describe('number text', () => {
  it('writes four-place percents with two places and signs a change', () => {
    expect(percentText('35.7143', 'vi')).toBe('35,71%');
    expect(percentText('35.7143', 'en')).toBe('35.71%');
    expect(deltaText('20.0000', 'vi')).toBe('+20,00');
    expect(deltaText('-0.5000', 'vi')).toBe('-0,50');
    expect(deltaText('0.0000', 'vi')).toBe('0,00');
  });
  it('draws the summary for the phone: the company rate and the units, without the table of projects and without the blocked tiles', async () => {
    open('summary');
    const panel = await screen.findByTestId('leader-rates');
    expect(within(panel).getAllByText(percentText('40.0000', 'vi')).length).toBeGreaterThan(0);
    expect(within(panel).getByTestId('leader-units-list').textContent).toContain('BAN-1');
    expect(within(panel).queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('leader-blocked')).toBeNull();
  });
});
