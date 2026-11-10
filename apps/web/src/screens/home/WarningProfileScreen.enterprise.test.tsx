import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditionProvider } from '../../editions/EditionContext';
import { PUBLIC_BUNDLE, installEdition, resetEdition } from '../../editions/edition';
import { enterpriseBundle } from '../../editions/enterprise';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import WarningProfileScreen, { evidenceRowsFor } from './WarningProfileScreen';
import { warningBody } from './WarningsScreen.test';

// The evidence of HOME-06 on the enterprise edition says nothing of the public pack: no plan of the Prime Minister, no local plan, no Treasury, no CENTRAL or LOCAL.
const ROUTE = routeOf('HOME-06', 'FR-HOME-06');
const W1 = '00000000-0000-4000-8000-000000000a01';
const cell = (bucket: string, level: string, planPm: string, planLocal: string, disbursed: string | null) => ({ bucket, budget_level: level, plan_pm_assigned_vnd: planPm, plan_local_added_vnd: planLocal, disbursed_treasury_vnd: disbursed, rate_pm_pct: disbursed === null ? null : '22.0000', rate_total_pct: null, rate_null_reason: null, treasury_coverage: 'COMPLETE' });
const evidence = { snapshot_id: '00000000-0000-4000-8000-0000000000f2', as_of_date: '2027-10-12', cells: [cell('CARRYOVER', 'CENTRAL', '0', '0', null), cell('CARRYOVER', 'LOCAL', '0', '0', null), cell('CURRENT_YEAR', 'CENTRAL', '1000000000000', '0', '220000000000'), cell('CURRENT_YEAR', 'LOCAL', '0', '0', null)] };

afterEach(() => {
  cleanup();
  resetEdition();
});

describe('HOME-06 evidence: enterprise against public', () => {
  it('names the columns and the cells in the words of the enterprise, with no public wording and no code', async () => {
    installEdition(enterpriseBundle);
    mount(
      <EditionProvider edition={enterpriseBundle}>
        <WarningProfileScreen route={ROUTE} />
      </EditionProvider>,
      harness((operation) => (operation === 'getHomeWarnings' ? { items: [warningBody(W1, { status: 'OPEN', evidence })], next_cursor: null, as_of: '2027-10-15T03:00:00Z' } : new Error(operation))),
      { permissions: ['home.read'] },
      `/?warning=${W1}`,
    );
    const table = within(await screen.findByTestId('profile-evidence'));
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Ô', 'Kế hoạch vốn được giao', 'Giải ngân (số liệu đã chốt)', 'Tỷ lệ theo kế hoạch vốn được giao']);
    expect(table.getAllByRole('row').slice(1).map((row) => row.querySelector('th, td')?.textContent)).toEqual(['Vốn kéo dài', 'Vốn năm']);
    const text = screen.getByTestId('profile-evidence').textContent ?? '';
    expect(text).not.toMatch(/CENTRAL|LOCAL|CURRENT_YEAR|CARRYOVER|Kho bạc|Thủ tướng|địa phương/u);
  });

  it('keeps the public columns and the codes of the cells on the public edition', async () => {
    mount(
      <EditionProvider edition={PUBLIC_BUNDLE}>
        <WarningProfileScreen route={ROUTE} />
      </EditionProvider>,
      harness((operation) => (operation === 'getHomeWarnings' ? { items: [warningBody(W1, { status: 'OPEN', evidence })], next_cursor: null, as_of: '2027-10-15T03:00:00Z' } : new Error(operation))),
      { permissions: ['home.read'] },
      `/?warning=${W1}`,
    );
    const table = within(await screen.findByTestId('profile-evidence'));
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Ô', tr('home.profile.evidence.planPm'), tr('home.profile.evidence.planLocal'), tr('home.profile.evidence.disbursed'), tr('home.profile.evidence.ratePm')]);
    expect(table.getAllByRole('row')).toHaveLength(5);
    expect(screen.getByTestId('profile-evidence').textContent).toContain('CURRENT_YEAR · CENTRAL');
  });

  it('leaves out only the empty cells of the local level, and only for an edition with its own plan', () => {
    const cells = [
      { bucket: 'CURRENT_YEAR', budgetLevel: 'LOCAL', planPmVnd: '0', planLocalVnd: '0', disbursedVnd: null, ratePmPct: null, rateTotalPct: null, nullReason: null, coverage: 'NONE' },
      { bucket: 'CURRENT_YEAR', budgetLevel: 'LOCAL', planPmVnd: '0', planLocalVnd: '5', disbursedVnd: null, ratePmPct: null, rateTotalPct: null, nullReason: null, coverage: 'NONE' },
    ];
    expect(evidenceRowsFor(cells, true)).toEqual([cells[1]]);
    expect(evidenceRowsFor(cells, false)).toEqual(cells);
  });
});
