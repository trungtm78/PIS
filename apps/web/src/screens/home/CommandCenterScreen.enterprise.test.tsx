import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { EditionProvider } from '../../editions/EditionContext';
import { PUBLIC_BUNDLE } from '../../editions/edition';
import { enterpriseBundle } from '../../editions/enterprise';
import { snapshotDisbursedOf } from '../../editions/enterprise/screens/leader/hooks';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import CommandCenterScreen from './CommandCenterScreen';

// The command block of HOME-09 and of its presentation shows ONE disbursed figure: on the enterprise edition the frozen snapshot read for the leader panel, never the Treasury figure of the command center.
const CC = routeOf('HOME-09', 'FR-HOME-09');
afterEach(cleanup);

const tile = (code: string, unit: string, value: string) => ({ metric_code: code, value, numerator: null, denominator: null, null_reason: null, unit, formula: 'f', definition_status: 'PROPOSED_PENDING_SIGNOFF', context_token: `token-${code}.sig`, display_value: value });
const center = {
  snapshot_id: '00000000-0000-4000-8000-0000000000f2',
  snapshot_kind: 'PERIOD_CLOSE',
  as_of_date: '2026-11-06',
  treasury_cutoff_date: '2026-11-06',
  freshness: 'FRESH',
  definition_status: 'PROPOSED_PENDING_SIGNOFF',
  legal_confirmation_refs: [],
  scope: { unit_id: null, denominator_kind: null, projects: 3, scope_hash: 'h' },
  tiles: [tile('DISBURSED_TREASURY', 'VND', '543330000000'), tile('PLAN_TOTAL', 'VND', '1250000000000')],
  projects_without_data: 0,
  open_warnings: 0,
  overdue_explanations: 0,
  pending_reallocations: 0,
  quality_badge: 'NOT_ASSESSED',
};
const company = { level: 'COMPANY', id: null, code: null, name: null, projects: 3, plan_vnd: '1534000000000', disbursed_vnd: '928756000000', rate_pct: '60.5456', null_reason: null, last_year: { rate_pct: null, disbursed_vnd: null, null_reason: 'NO_PRIOR_SNAPSHOT' }, delta_points: null, trend: null };
const rates = { snapshot_id: 's-1', as_of_date: '2026-10-31', revision: 2, snapshot_hash: 'h', prior_snapshot_id: null, prior_as_of_date: null, definition_status: 'PROPOSED_PENDING_SIGNOFF', formula: 'f', company, units: [], projects: [], structure: { measure: 'DISBURSED', plan_total_vnd: '0', disbursed_total_vnd: '0', classes: [] }, as_of: '2026-11-09T01:00:00.000Z' };
const reads = (operation: string) => {
  if (operation === 'getCommandCenter') return center;
  if (operation === 'getLeaderRates') return rates;
  return { rows: [], items: [], tables: [], curve: [], counts: { overdue: 0, due_soon: 0, escalated: 0, open: 0 }, total: 0, by_source: {}, projects: [], truncated: false };
};

describe('HOME-09 on the enterprise edition: one disbursed figure', () => {
  it('shows the figure of the frozen snapshot in the command block and in the first board of the presentation, not the Treasury figure', async () => {
    mount(
      <EditionProvider edition={enterpriseBundle}>
        <CommandCenterScreen route={CC} />
      </EditionProvider>,
      harness((operation) => reads(operation)),
      { permissions: ['home.read'] },
    );
    await screen.findByTestId('home-details');
    await waitFor(() => expect(document.body.textContent).toContain('928.756.000.000'));
    expect(document.body.textContent).not.toContain('543.330.000.000');
    expect(document.body.textContent).toContain(tr('home.ov.hero.snapshotCaption', { date: '31/10/2026', revision: 2 }));
    await userEvent.click(screen.getByTestId('present-open'));
    const presentation = await screen.findByRole('dialog', { name: tr('home.present.page.title') });
    expect(within(presentation).getByRole('heading', { level: 2, name: tr('home.present.rates.title') })).toBeTruthy();
    await waitFor(() => expect(presentation.textContent).toContain('928.756.000.000'));
    expect(presentation.textContent).not.toContain('543.330.000.000');
    // The one date format of the page: day, month, year.
    expect(screen.getByTestId('leader-rates-context').textContent).toContain('31/10/2026');
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('names the Treasury as the source of the monthly curve beside it', async () => {
    mount(
      <EditionProvider edition={enterpriseBundle}>
        <CommandCenterScreen route={CC} />
      </EditionProvider>,
      harness((operation) => reads(operation)),
      { permissions: ['home.read'] },
    );
    await screen.findByTestId('home-details');
    expect(await screen.findByText(tr('home.ov.flow.treasury.title'))).toBeTruthy();
  });

  it('keeps the Treasury figure of the command center on the public edition', async () => {
    mount(
      <EditionProvider edition={PUBLIC_BUNDLE}>
        <CommandCenterScreen route={CC} />
      </EditionProvider>,
      harness((operation) => reads(operation)),
      { permissions: ['home.read'] },
    );
    await screen.findByTestId('home-details');
    expect(document.body.textContent).toContain('543330000000');
    expect(document.body.textContent).not.toContain('928');
    expect(screen.queryByText(tr('home.ov.flow.treasury.title'))).toBeNull();
  });
});

describe('the snapshot figure of the command block', () => {
  it('is loading, none (never 0 and never the Treasury) or ready with its day and revision', () => {
    expect(snapshotDisbursedOf(true, undefined)).toEqual({ state: 'loading' });
    expect(snapshotDisbursedOf(false, undefined)).toEqual({ state: 'none' });
    expect(snapshotDisbursedOf(false, { ...rates, company: { ...company, disbursed_vnd: null } } as never)).toEqual({ state: 'none' });
    expect(snapshotDisbursedOf(false, rates as never)).toEqual({ state: 'ready', valueVnd: '928756000000', asOfDate: '2026-10-31', revision: 2 });
  });
});
